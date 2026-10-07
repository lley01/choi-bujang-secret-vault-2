// 시험 전용 가짜 도구입니다. 실제 URL이나 키를 넣지 마세요.
export const FAKE_ENV = { SUPABASE_URL: 'https://dummy-project.example', SUPABASE_SECRET_KEY: 'dummy-server-key' };

export function fakeResponse() {
  const out = { headers: new Map(), status: undefined, body: undefined, ended: false };
  const response = {
    setHeader: (key, value) => out.headers.set(key.toLowerCase(), value),
    status: (value) => {
      out.status = value;
      return {
        json: (body) => { out.body = body; return out; },
        end: () => { out.ended = true; return out; },
      };
    },
  };
  return { response, out };
}

export async function withCapturedErrors(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { await run(); } finally { console.error = original; }
  return lines;
}

// supabase-js 질의 사슬 중 이 프로젝트가 쓰는 부분(select·insert·update·delete·eq·order·limit·maybeSingle)만 흉내 낸 메모리 저장소입니다.
export function createFakeStore(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  const log = { clients: [], queries: [] };
  let clock = 0;
  const project = (row, columns) => {
    if (!columns) return { ...row };
    return Object.fromEntries(columns.split(',').map((name) => name.trim()).map((name) => [name, row[name]]));
  };

  class Query {
    constructor() { this.op = 'select'; this.filters = []; this.orders = []; this.columns = null; this.limitCount = null; this.maybe = false; this.payload = null; }
    select(columns) { this.columns = columns; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    order(column, { ascending = true } = {}) { this.orders.push([column, ascending]); return this; }
    limit(count) { this.limitCount = count; return this; }
    maybeSingle() { this.maybe = true; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    matching() { return rows.filter((row) => this.filters.every(([column, value]) => row[column] === value)); }
    run() {
      log.queries.push({ op: this.op, filters: [...this.filters], payload: this.payload ? { ...this.payload } : null, columns: this.columns });
      if (this.op === 'insert') {
        if (rows.some((row) => row.id === this.payload.id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        rows.push({ owner_id: null, ...this.payload, created_at: ++clock });
        return { data: this.columns ? [project(rows.at(-1), this.columns)] : null, error: null };
      }
      if (this.op === 'update') {
        const hit = this.matching();
        hit.forEach((row) => Object.assign(row, this.payload));
        return { data: this.columns ? hit.map((row) => project(row, this.columns)) : null, error: null };
      }
      if (this.op === 'delete') {
        const hit = this.matching();
        hit.forEach((row) => rows.splice(rows.indexOf(row), 1));
        return { data: this.columns ? hit.map((row) => project(row, this.columns)) : null, error: null };
      }
      let found = this.matching();
      for (const [column, ascending] of [...this.orders].reverse()) {
        found = [...found].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
      }
      if (this.limitCount !== null) found = found.slice(0, this.limitCount);
      const data = found.map((row) => project(row, this.columns));
      return this.maybe ? { data: data[0] ?? null, error: null } : { data, error: null };
    }
  }

  const createSupabase = (url, key, options) => {
    log.clients.push({ url, key, options });
    return { from: (table) => { if (table !== 'notes') throw new Error(`unexpected table ${table}`); return new Query(); } };
  };
  return { createSupabase, rows, log };
}
