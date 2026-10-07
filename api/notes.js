// 가상 메모를 Supabase 테이블(public.notes)에서 읽어 돌려주는 서버 함수입니다.
// 3단계: 요청의 로그인 토큰을 시작 틀의 src/verify-login.mjs로 검사합니다. 도우미는 고치지 않고 불러 쓰기만 합니다.
// - 토큰이 없거나 검사에 실패하면 자료 없이 401로 거부합니다.
// - 브라우저가 보낸 userId·role 같은 값은 읽지 않습니다. 신원은 검사 결과(kind, userId)에서만 얻습니다.
// SUPABASE_URL 과 SUPABASE_SECRET_KEY 는 Vercel 환경변수(비밀 입력란)에서만 읽습니다.
// 키와 토큰은 코드·응답·로그에 넣지 않습니다. 로그에는 고정된 오류 이름과 오류 코드만 남깁니다.
import { createClient } from '@supabase/supabase-js';
import alephConfig from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from '../src/verify-login.mjs';

const MAX_NOTES = 100;

// 도우미가 던지는 오류 메시지는 invalid_login_issuer 처럼 고정된 영문 코드입니다. 그 모양일 때만 로그에 남깁니다.
const safeCode = (error) => (typeof error?.message === 'string' && /^[a-z_]{1,60}$/u.test(error.message)
  ? error.message : 'unknown');

export function createNotesHandler({ env = process.env, createSupabase = createClient,
  loginConfig = alephConfig, loginOptions = {}, verifyLogin } = {}) {
  // 검사기는 서버 런타임에서 한 번만 만들고 다시 씁니다. 만들기에 실패하면 저장하지 않고 요청마다 거부합니다.
  let verifier = verifyLogin ?? null;
  const getVerifier = () => {
    verifier ??= createLoginVerifier({ config: loginConfig, supabaseSecretKey: env.SUPABASE_SECRET_KEY, ...loginOptions });
    return verifier;
  };

  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Authorization');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    }

    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) {
      console.error('NOTES_ENV_MISSING');
      return response.status(500).json({ error: 'SERVER_NOT_CONFIGURED' });
    }

    // 로그인 확인: Authorization 헤더 하나만 검사기에 넘깁니다. 쿼리·본문·다른 헤더의 userId·role은 보지 않습니다.
    let identity;
    try {
      identity = await getVerifier()(request.headers?.authorization);
    } catch (error) {
      console.error('NOTES_AUTH_UNAVAILABLE', safeCode(error));
      return response.status(500).json({ error: 'AUTH_UNAVAILABLE' });
    }
    if (!identity) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return response.status(401).json({ error: 'LOGIN_REQUIRED' });
    }

    try {
      const supabase = createSupabase(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await supabase
        .from('notes')
        .select('title, content')
        .order('created_at', { ascending: true })
        .order('title', { ascending: true })
        .limit(MAX_NOTES);
      if (error || !Array.isArray(data)) {
        console.error('NOTES_QUERY_FAILED', error?.code ?? 'unknown');
        return response.status(500).json({ error: 'NOTES_UNAVAILABLE' });
      }
      // 화면에 필요한 두 칸만 내보냅니다. id·owner_id 등 다른 칸과 키는 응답에 넣지 않습니다.
      return response.status(200).json({
        notes: data.map(({ title, content }) => ({ title, content })),
      });
    } catch {
      console.error('NOTES_REQUEST_FAILED');
      return response.status(500).json({ error: 'NOTES_UNAVAILABLE' });
    }
  };
}

export default createNotesHandler();
