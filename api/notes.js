// 2단계: 가상 메모를 Supabase 테이블(public.notes)에서 읽어 돌려주는 서버 함수입니다.
// SUPABASE_URL 과 SUPABASE_SECRET_KEY 는 Vercel 환경변수(비밀 입력란)에서만 읽습니다.
// 키 값은 코드·응답·로그에 넣지 않습니다. 로그에는 고정된 오류 이름과 Supabase 오류 코드만 남깁니다.
// 알려진 약점: 이 함수는 아직 공개 주소입니다. 로그인·호출 한도·허용 경로가 없습니다(README 참고).
import { createClient } from '@supabase/supabase-js';

const MAX_NOTES = 100;

export function createNotesHandler({ env = process.env, createSupabase = createClient } = {}) {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
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
