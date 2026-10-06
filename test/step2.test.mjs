import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNotesHandler } from '../api/notes.js';
import { runAttackChecks } from '../src/attack-check.mjs';

// 아래 값은 모두 시험용 가짜 값입니다. 실제 URL이나 키를 넣지 마세요.
const FAKE_ENV = { SUPABASE_URL: 'https://dummy-project.example', SUPABASE_SECRET_KEY: 'dummy-server-key' };

function fakeResponse() {
  const out = { headers: new Map(), status: undefined, body: undefined };
  const response = {
    setHeader: (key, value) => out.headers.set(key.toLowerCase(), value),
    status: (value) => { out.status = value; return { json: (body) => { out.body = body; return out; } }; },
  };
  return { response, out };
}

function fakeSupabase(result, calls) {
  return (url, key, options) => {
    calls.push({ url, key, options });
    const query = {
      select: (columns) => { calls.push({ select: columns }); return query; },
      order: () => query,
      limit: () => Promise.resolve(result),
    };
    return { from: (table) => { calls.push({ from: table }); return query; } };
  };
}

async function withCapturedErrors(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { await run(); } finally { console.error = original; }
  return lines;
}

test('/api/notes는 GET만 받고 캐시하지 않는다', async () => {
  const handler = createNotesHandler({ env: FAKE_ENV, createSupabase: fakeSupabase({ data: [] }, []) });
  const { response, out } = fakeResponse();
  await handler({ method: 'POST' }, response);
  assert.equal(out.status, 405);
  assert.equal(out.headers.get('allow'), 'GET');
  assert.equal(out.headers.get('cache-control'), 'no-store');
});

test('/api/notes는 환경변수가 없으면 키 값 없이 500으로 거절한다', async () => {
  for (const env of [{}, { SUPABASE_URL: FAKE_ENV.SUPABASE_URL }, { SUPABASE_SECRET_KEY: FAKE_ENV.SUPABASE_SECRET_KEY }]) {
    let called = false;
    const handler = createNotesHandler({ env, createSupabase: () => { called = true; } });
    const { response, out } = fakeResponse();
    const logs = await withCapturedErrors(() => handler({ method: 'GET' }, response));
    assert.equal(out.status, 500);
    assert.equal(out.body.error, 'SERVER_NOT_CONFIGURED');
    assert.equal(called, false);
    assert.ok(!JSON.stringify([out.body, logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
  }
});

test('/api/notes는 title·content만 돌려주고 키를 응답·로그에 넣지 않는다', async () => {
  const calls = [];
  const rows = [
    { id: 'x1', owner_id: 'o1', title: '과제', content: '실습용 가상 과제 기록' },
    { id: 'x2', owner_id: null, title: '포트폴리오', content: '실습용 가상 포트폴리오 기록' },
  ];
  const handler = createNotesHandler({ env: FAKE_ENV, createSupabase: fakeSupabase({ data: rows, error: null }, calls) });
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET' }, response));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { notes: [
    { title: '과제', content: '실습용 가상 과제 기록' },
    { title: '포트폴리오', content: '실습용 가상 포트폴리오 기록' },
  ] });
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls[0].options.auth, { persistSession: false, autoRefreshToken: false });
  assert.equal(calls[0].key, FAKE_ENV.SUPABASE_SECRET_KEY);
  assert.ok(calls.some((call) => call.from === 'notes'));
  assert.ok(calls.some((call) => call.select === 'title, content'));
  assert.ok(!JSON.stringify([out.body, [...out.headers], logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
});

test('/api/notes는 Supabase 오류 때 오류 코드만 기록하고 500으로 답한다', async () => {
  const error = { code: '42501', message: `permission denied for ${FAKE_ENV.SUPABASE_SECRET_KEY}` };
  for (const createSupabase of [
    fakeSupabase({ data: null, error }, []),
    () => { throw new Error(FAKE_ENV.SUPABASE_SECRET_KEY); },
  ]) {
    const handler = createNotesHandler({ env: FAKE_ENV, createSupabase });
    const { response, out } = fakeResponse();
    const logs = await withCapturedErrors(() => handler({ method: 'GET' }, response));
    assert.equal(out.status, 500);
    assert.equal(out.body.error, 'NOTES_UNAVAILABLE');
    assert.ok(!JSON.stringify([out.body, logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
  }
});

test('공개 data.json에는 메모가 남지 않는다', () => {
  assert.equal(existsSync(new URL('../public/data.json', import.meta.url)), false);
  const source = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8'));
  assert.deepEqual(source.notes, []);
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /fetch\('\/api\/notes'/u);
  assert.doesNotMatch(page, /fetch\('\/data\.json'/u);
});

test('2단계 자기 점검은 /data.json 제거와 /api/notes 공개 약점을 실제 응답대로 기록한다', async () => {
  const config = { step: 2, sampleMarker: 'SAMPLE_NOTE_1', publicAppUrl: 'https://student-defense.vercel.app' };
  const originalFetch = globalThis.fetch;
  const requested = [];
  try {
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      if (String(url).endsWith('/data.json')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ notes: [{ title: '가상', content: '실습용 가상 본문' }] }), { status: 200 });
    };
    const results = await runAttackChecks(config);
    assert.deepEqual(requested, [
      'https://student-defense.vercel.app/data.json',
      'https://student-defense.vercel.app/api/notes',
    ]);
    assert.match(results[0].observed, /보이지 않음 \(HTTP 404\)/u);
    assert.match(results[1].observed, /가상 메모를 돌려줌/u);
    assert.ok(!JSON.stringify(results).includes('실습용 가상 본문'));

    globalThis.fetch = async () => new Response(JSON.stringify({ notes: [{ title: 'a', content: 'b' }] }), { status: 200 });
    const leaked = await runAttackChecks(config);
    assert.match(leaked[0].observed, /아직 보임/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
