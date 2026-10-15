// npm run matrix                      → 네트워크 없이 표만 만듦(자동 시험은 미실행, 기록 파일이 있으면 반영)
// npm run matrix -- --send            → 토큰 없이 보낼 수 있는 자동 시험을 배포 주소로 실제로 보냄
// npm run matrix -- --template        → 직접·심판 결과 기록 틀 matrix-evidence.json 을 만듦(이미 있으면 그대로 둠)
// 기록 파일 matrix-evidence.json 이 있으면 자동으로 읽습니다(--evidence <경로>로 바꿀 수 있음). 결과는 artifacts/stage-matrix.md·json.
// 기록 파일과 artifacts/ 는 커밋하지 않습니다(.gitignore).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildMatrix, evidenceTemplate, readEvidence, renderMarkdown } from '../src/stage-matrix.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const known = new Set(['--send', '--template', '--evidence']);
try {
  for (let i = 0; i < args.length; i += 1) {
    if (!known.has(args[i])) throw new Error(`모르는 옵션입니다: ${args[i]}`);
    if (args[i] === '--evidence') i += 1;
  }
  const evidenceArg = args.includes('--evidence') ? args[args.indexOf('--evidence') + 1] : undefined;
  if (args.includes('--evidence') && !evidenceArg) throw new Error('--evidence 다음에 기록 파일 경로를 적어 주세요.');
  const evidencePath = resolve(root, evidenceArg ?? 'matrix-evidence.json');

  if (args.includes('--template')) {
    if (existsSync(evidencePath)) {
      console.log(`기록 파일이 이미 있어 그대로 둡니다: ${evidencePath}`);
    } else {
      writeFileSync(evidencePath, `${JSON.stringify(evidenceTemplate(), null, 2)}\n`, { flag: 'wx' });
      console.log(`기록 틀을 만들었습니다(모두 비어 있음 = 미실행): ${evidencePath}`);
    }
    process.exit(0);
  }

  const config = JSON.parse(readFileSync(join(root, 'aleph.config.json'), 'utf8'));
  let evidence = new Map();
  if (existsSync(evidencePath)) {
    let entries;
    try { entries = JSON.parse(readFileSync(evidencePath, 'utf8')); } catch { throw new Error(`기록 파일이 JSON 형식이 아닙니다: ${evidencePath}`); }
    evidence = readEvidence(entries);
  } else if (evidenceArg) {
    throw new Error(`기록 파일이 없습니다: ${evidencePath}`);
  }

  const matrix = await buildMatrix({ config, send: args.includes('--send'), evidence });
  const markdown = renderMarkdown(matrix);
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts', 'stage-matrix.md'), markdown);
  writeFileSync(join(root, 'artifacts', 'stage-matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  console.log(markdown);
  console.log('저장: artifacts/stage-matrix.md, artifacts/stage-matrix.json (커밋하지 않음)');
} catch (error) {
  console.error(`대조표를 만들지 못했습니다: ${error.message}`);
  process.exit(1);
}
