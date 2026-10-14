// 10단계: 검증한 안전 정책 사본으로 "시험 정책"을 되돌리는 절차입니다. 두 번에 나눠 실행합니다.
//   ① 미리보기: npm run policy:restore -- <사본> <침해 전 SHA-256> --service <서비스>
//      바뀔 항목과 보존할 항목, 확인 코드만 보여 주고 아무 파일도 바꾸지 않습니다.
//   ② 실행:    npm run policy:restore -- <사본> <침해 전 SHA-256> --service <서비스> --apply <확인 코드>
//      미리보기와 같은 상태일 때만(확인 코드가 같을 때만) 되돌리고, 감사 이력에 한 줄을 덧붙입니다.
// - 사본 검증은 scripts/policy-diff.mjs와 같습니다. 사본이 없거나 검증에 실패하면 중단합니다.
// - 되돌리는 것: aleph.config.json의 allowedRoutes 중 고른 서비스(/api/<서비스>/…)의 경로만입니다.
// - 보존하는 것: 다른 서비스의 경로와 순서, aleph.config.json의 다른 항목(step·judgeIssuer 등), 판정기 규칙 코드(src/decider.mjs).
//   규칙은 코드라 자동으로 되돌리지 않고, 사본과 다른 규칙 이름은 "직접 확인"으로만 알려 줍니다.
// - 감사 이력: audit/policy-restore.jsonl 에 덧붙이기만 합니다(기존 줄을 지우거나 고치지 않음). 키·토큰·메모 내용은 남기지 않습니다.
// - 운영 DB·Supabase·Vercel 설정은 건드리지 않고 네트워크도 쓰지 않습니다. 바뀐 설정은 학생이 검토해 커밋·배포해야 반영됩니다.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyStop, currentTestPolicy, loadVerifiedCopy } from './policy-diff.mjs';

const SERVICE = /^[a-z][a-z0-9-]{0,31}$/u;
const CODE = /^[0-9a-f]{12}$/u;
export const AUDIT_FILE = join('audit', 'policy-restore.jsonl');
const stop = (message) => { throw new PolicyStop(message); };
const serviceOf = (route) => /^[A-Z]+ \/api\/([a-z0-9-]+)(?:\/|$)/u.exec(route)?.[1] ?? null;

// 바뀔 항목을 계산합니다. 파일은 바꾸지 않습니다.
export function planRestore(safe, current, service, copySha256) {
  if (typeof service !== 'string' || !SERVICE.test(service)) stop('되돌릴 서비스(--service notes 등)가 없습니다. 중단합니다.');
  const mine = (route) => serviceOf(route) === service;
  const before = current.allowedRoutes.filter(mine);
  const target = safe.allowedRoutes.filter(mine);
  const at = current.allowedRoutes.findIndex(mine);
  const others = current.allowedRoutes.filter((route) => !mine(route));
  const index = at < 0 ? others.length : current.allowedRoutes.slice(0, at).filter((route) => !mine(route)).length;
  const after = [...others.slice(0, index), ...target, ...others.slice(index)];
  if (after.length < 1 || after.length > 20) stop('되돌린 허용 경로가 1~20개가 아니게 됩니다. 중단합니다.');
  const removed = before.filter((route) => !target.includes(route));
  const added = target.filter((route) => !before.includes(route));
  const code = createHash('sha256').update(JSON.stringify({ copySha256, service, from: current.allowedRoutes, to: after })).digest('hex').slice(0, 12);
  return {
    service, code, removed, added, allowedRoutes: after, changed: removed.length + added.length > 0 || after.join() !== current.allowedRoutes.join(),
    preserved: { otherRoutes: others, step: current.step },
    rulesToCheck: {
      onlyInCopy: safe.ruleIds.filter((id) => !current.ruleIds.includes(id)),
      onlyInCurrent: current.ruleIds.filter((id) => !safe.ruleIds.includes(id)),
    },
  };
}

export function formatPlan(plan) {
  const lines = [`되돌릴 서비스: ${plan.service}`];
  if (!plan.changed) lines.push('바뀔 항목 없음');
  for (const route of plan.removed) lines.push(`- 허용 경로 빠짐: ${route}`);
  for (const route of plan.added) lines.push(`+ 허용 경로 되돌림: ${route}`);
  lines.push(`보존: 다른 서비스 허용 경로 ${plan.preserved.otherRoutes.length}개, step ${plan.preserved.step}, 판정기 규칙 코드, 감사 이력`);
  for (const id of plan.rulesToCheck.onlyInCopy) lines.push(`! 직접 확인(자동으로 되돌리지 않음): 사본에만 있는 규칙 ${id}`);
  for (const id of plan.rulesToCheck.onlyInCurrent) lines.push(`! 직접 확인(자동으로 되돌리지 않음): 현재에만 있는 규칙 ${id}`);
  return lines;
}

// 확인 코드가 미리보기와 같을 때만 aleph.config.json의 allowedRoutes를 바꾸고 감사 이력을 덧붙입니다.
export async function applyRestore(plan, confirmCode, { root, copySha256, now = () => new Date() }) {
  if (typeof confirmCode !== 'string' || !CODE.test(confirmCode)) stop('확인 코드가 없습니다. 먼저 미리보기로 바뀔 항목을 확인하세요. 중단합니다.');
  if (confirmCode !== plan.code) stop('확인 코드가 다릅니다(미리보기 뒤에 상태가 바뀌었거나 다른 사본·서비스입니다). 중단합니다.');
  if (!plan.changed) return false;
  const configPath = resolve(root, 'aleph.config.json');
  const raw = await readFile(configPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const config = JSON.parse(raw);
  config.allowedRoutes = plan.allowedRoutes;
  const temp = `${configPath}.restore-tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2).replace(/\n/gu, eol)}${eol}`, 'utf8');
  await rename(temp, configPath);
  const auditPath = resolve(root, AUDIT_FILE);
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify({ at: now().toISOString(), action: 'restore_test_policy', service: plan.service,
    copySha256, code: plan.code, removed: plan.removed, added: plan.added })}\n`, { encoding: 'utf8', flag: 'a' });
  return true;
}

export function parseArgs(argv) {
  const [copy, sha256, ...rest] = argv;
  const options = { copy, sha256, service: undefined, apply: undefined };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--service') options.service = rest[++i];
    else if (rest[i] === '--apply') options.apply = rest[++i] ?? '';
    else stop(`알 수 없는 인자입니다: ${String(rest[i]).slice(0, 40)}. 중단합니다.`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    const options = parseArgs(process.argv.slice(2));
    const safe = await loadVerifiedCopy(options.copy, options.sha256);
    const plan = planRestore(safe, await currentTestPolicy(root), options.service, options.sha256);
    process.stdout.write(`${formatPlan(plan).join('\n')}\n`);
    if (options.apply === undefined) {
      process.stdout.write(plan.changed
        ? `미리보기입니다. 아무것도 바꾸지 않았습니다.\n위 항목을 확인했으면 같은 명령 끝에 --apply ${plan.code} 를 붙여 실행하세요.\n`
        : '미리보기입니다. 되돌릴 항목이 없습니다.\n');
    } else {
      const done = await applyRestore(plan, options.apply, { root, copySha256: options.sha256 });
      process.stdout.write(done ? `되돌렸습니다: aleph.config.json(allowedRoutes, ${plan.service}만). 감사 이력 ${AUDIT_FILE}에 한 줄을 덧붙였습니다.\n검토한 뒤 커밋·배포해야 반영됩니다.\n`
        : '되돌릴 항목이 없어 아무것도 바꾸지 않았습니다.\n');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof PolicyStop ? error.message : '정책 되돌리기 중 오류가 나서 중단합니다.'}\n`);
    process.exitCode = 1;
  }
}
