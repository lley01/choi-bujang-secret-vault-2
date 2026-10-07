// 가상 메모 API(/api/notes, /api/notes/:id)의 공통 로직입니다. api/notes.js 와 api/notes/[id].js 가 불러 씁니다.
// 모든 요청은 시작 틀의 src/verify-login.mjs 로 로그인 토큰을 먼저 검사합니다(도우미는 고치지 않습니다).
// - 토큰이 없거나 검사에 실패하면 자료 없이 401로 거부합니다.
// - 신원은 검사 결과(userId)에서만 얻습니다. 브라우저가 보낸 userId·owner_id·role 같은 값은 읽지 않습니다.
// - 추가(POST)할 때는 서버가 확인한 userId를 owner_id로 저장합니다. 목록(GET)은 그 사용자의 메모만 돌려줍니다.
// - 알려진 허점(4단계에서 고칠 것): 한 건 조회·수정·삭제(/:id)는 아직 소유자를 검사하지 않습니다.
//   그래서 로그인한 B가 A의 메모 id를 알면 읽고 고치고 지울 수 있습니다.
// SUPABASE_URL 과 SUPABASE_SECRET_KEY 는 Vercel 환경변수(비밀 입력란)에서만 읽습니다.
// 키와 토큰은 코드·응답·로그에 넣지 않습니다. 로그에는 고정된 오류 이름과 오류 코드만 남깁니다.
import { createClient } from '@supabase/supabase-js';
import alephConfig from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from './verify-login.mjs';

const MAX_LIST = 100;
const MAX_TITLE = 200;
const MAX_BODY = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const COLUMNS = 'id, title, content';

// 도우미가 던지는 오류 메시지는 invalid_login_issuer 처럼 고정된 영문 코드입니다. 그 모양일 때만 로그에 남깁니다.
const safeCode = (error) => (typeof error?.message === 'string' && /^[a-z_]{1,60}$/u.test(error.message)
  ? error.message : 'unknown');

// 화면과 API의 이름은 body, 테이블의 칸 이름은 content 입니다.
const toNote = (row) => ({ id: row.id, title: row.title, body: row.content });

function parseJsonBody(request) {
  let value = request.body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// 쓰기 요청 본문에서 title·body만 꺼냅니다. owner_id·userId·role 등 다른 이름은 보지 않습니다.
function readNoteFields(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > MAX_TITLE) return { error: 'INVALID_TITLE' };
  if (typeof input.body !== 'string' || input.body.length > MAX_BODY) return { error: 'INVALID_NOTE_BODY' };
  return { title, content: input.body };
}

// 경로의 id는 주소(path)에서 읽고, 없을 때만 Vercel이 채운 request.query.id를 씁니다.
function readPathId(request) {
  const fromUrl = typeof request.url === 'string'
    ? /^\/api\/notes\/([^/?#]+)\/?(?:[?#]|$)/u.exec(request.url)?.[1] : undefined;
  if (fromUrl !== undefined) return fromUrl;
  return typeof request.query?.id === 'string' ? request.query.id : undefined;
}

export function createNotesService({ env = process.env, createSupabase = createClient,
  loginConfig = alephConfig, loginOptions = {}, verifyLogin, generateId = () => crypto.randomUUID() } = {}) {
  // 검사기는 서버 런타임에서 한 번만 만들고 다시 씁니다. 만들기에 실패하면 저장하지 않고 요청마다 거부합니다.
  let verifier = verifyLogin ?? null;
  const getVerifier = () => {
    verifier ??= createLoginVerifier({ config: loginConfig, supabaseSecretKey: env.SUPABASE_SECRET_KEY, ...loginOptions });
    return verifier;
  };
  const fail = (response, status, error) => response.status(status).json({ error });

  // 공통 관문: 방법 확인 → 환경변수 → 로그인 토큰 검사. 통과하면 { identity, supabase }를 돌려주고, 아니면 이미 응답했으므로 null.
  async function enter(request, response, allowed) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Authorization');
    if (!allowed.includes(request.method)) {
      response.setHeader('Allow', allowed.join(', '));
      fail(response, 405, 'METHOD_NOT_ALLOWED');
      return null;
    }
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) {
      console.error('NOTES_ENV_MISSING');
      fail(response, 500, 'SERVER_NOT_CONFIGURED');
      return null;
    }
    let identity;
    try {
      identity = await getVerifier()(request.headers?.authorization);
    } catch (error) {
      console.error('NOTES_AUTH_UNAVAILABLE', safeCode(error));
      fail(response, 500, 'AUTH_UNAVAILABLE');
      return null;
    }
    if (!identity) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      fail(response, 401, 'LOGIN_REQUIRED');
      return null;
    }
    if (!UUID.test(identity.userId ?? '')) {
      console.error('NOTES_USER_ID_INVALID');
      fail(response, 500, 'AUTH_UNAVAILABLE');
      return null;
    }
    let supabase;
    try {
      supabase = createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch {
      // 클라이언트를 만들다 난 오류의 메시지에는 주소나 키 조각이 섞일 수 있어 기록하지 않습니다.
      console.error('NOTES_CLIENT_FAILED');
      fail(response, 500, 'NOTES_UNAVAILABLE');
      return null;
    }
    return { identity, supabase };
  }

  const upstreamFailed = (response, error, name) => {
    console.error(name, error?.code ?? 'unknown');
    return fail(response, 500, 'NOTES_UNAVAILABLE');
  };

  // GET /api/notes (내 메모 목록), POST /api/notes (추가)
  async function collection(request, response) {
    const entered = await enter(request, response, ['GET', 'POST']);
    if (!entered) return undefined;
    const { identity, supabase } = entered;
    try {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('notes').select(COLUMNS)
          .eq('owner_id', identity.userId)
          .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(MAX_LIST);
        if (error || !Array.isArray(data)) return upstreamFailed(response, error, 'NOTES_LIST_FAILED');
        return response.status(200).json(data.map(toNote));
      }

      const input = parseJsonBody(request);
      if (!input) return fail(response, 400, 'INVALID_JSON');
      const fields = readNoteFields(input);
      if (fields.error) return fail(response, 400, fields.error);
      const hasId = input.id !== undefined && input.id !== null;
      if (hasId && (typeof input.id !== 'string' || !UUID.test(input.id))) return fail(response, 400, 'INVALID_ID');
      const id = hasId ? input.id.toLowerCase() : generateId();
      const { error } = await supabase.from('notes').insert({
        id, owner_id: identity.userId, title: fields.title, content: fields.content,
      });
      if (error?.code === '23505') return fail(response, 409, 'ID_EXISTS');
      if (error) return upstreamFailed(response, error, 'NOTES_CREATE_FAILED');
      return response.status(201).json({ id });
    } catch {
      console.error('NOTES_REQUEST_FAILED');
      return fail(response, 500, 'NOTES_UNAVAILABLE');
    }
  }

  // GET·PUT·DELETE /api/notes/:id  (아직 소유자 검사 없음: 4단계에서 고칠 허점)
  async function item(request, response) {
    const entered = await enter(request, response, ['GET', 'PUT', 'DELETE']);
    if (!entered) return undefined;
    const { supabase } = entered;
    const rawId = readPathId(request);
    if (typeof rawId !== 'string' || !UUID.test(rawId)) return fail(response, 400, 'INVALID_ID');
    const id = rawId.toLowerCase();
    try {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('notes').select(COLUMNS).eq('id', id).maybeSingle();
        if (error) return upstreamFailed(response, error, 'NOTES_READ_FAILED');
        if (!data) return fail(response, 404, 'NOT_FOUND');
        return response.status(200).json(toNote(data));
      }

      if (request.method === 'PUT') {
        const input = parseJsonBody(request);
        if (!input) return fail(response, 400, 'INVALID_JSON');
        const fields = readNoteFields(input);
        if (fields.error) return fail(response, 400, fields.error);
        if (input.id !== undefined && input.id !== null
            && (typeof input.id !== 'string' || input.id.toLowerCase() !== id)) return fail(response, 400, 'ID_MISMATCH');
        // owner_id는 바꾸지 않습니다. title과 content만 갱신합니다.
        const { data, error } = await supabase.from('notes')
          .update({ title: fields.title, content: fields.content }).eq('id', id).select(COLUMNS);
        if (error || !Array.isArray(data)) return upstreamFailed(response, error, 'NOTES_UPDATE_FAILED');
        if (!data.length) return fail(response, 404, 'NOT_FOUND');
        return response.status(200).json(toNote(data[0]));
      }

      const { data, error } = await supabase.from('notes').delete().eq('id', id).select('id');
      if (error || !Array.isArray(data)) return upstreamFailed(response, error, 'NOTES_DELETE_FAILED');
      if (!data.length) return fail(response, 404, 'NOT_FOUND');
      return response.status(204).end();
    } catch {
      console.error('NOTES_REQUEST_FAILED');
      return fail(response, 500, 'NOTES_UNAVAILABLE');
    }
  }

  return { collection, item };
}
