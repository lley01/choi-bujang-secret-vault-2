// 10단계: 침해 전에 검증한 안전 정책 사본과 현재 시험 정책의 "차이만" 보여 줍니다.
// - 읽기 전용입니다. 운영 정책·aleph.config.json·src/decider.mjs·DB를 바꾸지 않고, 파일을 쓰지 않으며, 네트워크도 쓰지 않습니다.
// - 사본 검증: 사본 파일 바이트의 SHA-256이 학생이 침해 전에 따로 기록해 둔 지문(64자리 소문자 16진수)과 같아야 합니다.
//   지문은 사본 파일 안이 아니라 명령 인자로 받습니다(사본을 바꾼 사람이 지문까지 다시 계산해 넣어도 통과하지 못하게).
// - 사본이 없거나, 지문이 없거나 다르거나, 사본 형식이 틀리면 비교하지 않고 중단합니다(종료 코드 1, 첫 오류 한 줄).
// - 출력은 규칙·허용 경로·단계의 차이뿐입니다. 정책 전체, 키, 토큰, 메모 내용은 출력하지 않습니다.
//
// 사본 형식(aleph.policy.v1): { "schema": "aleph.policy.v1", "step": 정수, "ruleIds": [...], "allowedRoutes": ["METHOD /path", ...] }
// 실행: npm run policy:diff -- <안전 정책 사본 경로> <침해 전에 기록한 SHA-256>
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const POLICY_SCHEMA = 'aleph.policy.v1';
const MAX_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const RULE_ID = /^[a-z][a-z0-9_.-]{0,79}$/iu;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9_\-/:]*$/u;
const KEYS = ['allowedRoutes', 'ruleIds', 'schema', 'step'];

export class PolicyStop extends Error {}
const stop = (message) => { throw new PolicyStop(message); };

const uniqueStrings = (value, pattern) => Array.isArray(value) && value.length <= 80
  && value.every((item) => typeof item === 'string' && pattern.test(item)) && new Set(value).size === value.length;

// 정책 모양 검사. 틀리면 이유 한 줄로 중단합니다.
export function checkPolicyShape(policy, label) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).sort().join(',') !== KEYS.join(',')) stop(`${label} 형식이 아닙니다(schema·step·ruleIds·allowedRoutes만 있어야 함).`);
  if (policy.schema !== POLICY_SCHEMA) stop(`${label}의 schema가 ${POLICY_SCHEMA}가 아닙니다.`);
  if (!Number.isInteger(policy.step) || policy.step < 1 || policy.step > 20) stop(`${label}의 step이 올바르지 않습니다.`);
  if (!uniqueStrings(policy.ruleIds, RULE_ID)) stop(`${label}의 ruleIds가 올바르지 않습니다.`);
  if (!uniqueStrings(policy.allowedRoutes, ROUTE)) stop(`${label}의 allowedRoutes가 올바르지 않습니다.`);
  return policy;
}

// 안전 정책 사본을 읽고 검증합니다. 사본이 없거나 검증에 실패하면 중단합니다.
export async function loadVerifiedCopy(path, expectedSha256) {
  if (typeof path !== 'string' || !path) stop('안전 정책 사본 경로가 없습니다. 비교를 중단합니다.');
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) {
    stop('침해 전에 기록한 SHA-256 지문(64자리 소문자 16진수)이 없습니다. 비교를 중단합니다.');
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    stop('안전 정책 사본이 없습니다. 비교를 중단합니다.');
  }
  if (!info.isFile()) stop('안전 정책 사본이 일반 파일이 아닙니다(링크·폴더 불가). 비교를 중단합니다.');
  if (info.size > MAX_BYTES) stop('안전 정책 사본이 너무 큽니다. 비교를 중단합니다.');
  const bytes = await readFile(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) stop('안전 정책 사본 검증 실패: SHA-256 지문이 기록과 다릅니다. 비교를 중단합니다.');
  let policy;
  try {
    policy = JSON.parse(bytes.toString('utf8'));
  } catch {
    stop('안전 정책 사본 검증 실패: JSON이 아닙니다. 비교를 중단합니다.');
  }
  return checkPolicyShape(policy, '안전 정책 사본');
}

// 현재 시험 정책: 저장소의 판정기 규칙 이름과 설정의 단계·허용 경로입니다(읽기만 함).
export async function currentTestPolicy(root = fileURLToPath(new URL('..', import.meta.url))) {
  const config = JSON.parse(await readFile(resolve(root, 'aleph.config.json'), 'utf8'));
  const { RULE_IDS } = await import(pathToFileURL(resolve(root, 'src', 'decider.mjs')).href);
  return checkPolicyShape({ schema: POLICY_SCHEMA, step: config.step, ruleIds: [...RULE_IDS], allowedRoutes: [...(config.allowedRoutes ?? [])] }, '현재 시험 정책');
}

// 차이만 계산합니다. 같은 항목은 결과에 넣지 않습니다.
export function diffPolicies(safe, current) {
  const added = (from, to) => to.filter((item) => !from.includes(item));
  return {
    step: safe.step === current.step ? null : { safe: safe.step, current: current.step },
    ruleIds: { removed: added(current.ruleIds, safe.ruleIds), added: added(safe.ruleIds, current.ruleIds) },
    allowedRoutes: { removed: added(current.allowedRoutes, safe.allowedRoutes), added: added(safe.allowedRoutes, current.allowedRoutes) },
  };
}

export function formatDiff(diff) {
  const lines = [];
  if (diff.step) lines.push(`~ 단계: ${diff.step.safe} → ${diff.step.current}`);
  for (const id of diff.ruleIds.removed) lines.push(`- 규칙 빠짐: ${id}`);
  for (const id of diff.ruleIds.added) lines.push(`+ 규칙 추가: ${id}`);
  for (const route of diff.allowedRoutes.removed) lines.push(`- 허용 경로 빠짐: ${route}`);
  for (const route of diff.allowedRoutes.added) lines.push(`+ 허용 경로 추가: ${route}`);
  return lines.length ? lines : ['차이 없음'];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [path, sha256] = process.argv.slice(2);
    const safe = await loadVerifiedCopy(path, sha256);
    const current = await currentTestPolicy();
    process.stdout.write(`정책 차이(안전 사본 → 현재 시험 정책, 읽기 전용)\n${formatDiff(diffPolicies(safe, current)).join('\n')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof PolicyStop ? error.message : '정책 비교 중 오류가 나서 중단합니다.'}\n`);
    process.exitCode = 1;
  }
}
