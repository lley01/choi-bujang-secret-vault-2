import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploymentIdentity } from './deployment-identity.mjs';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'data.json');
const output = resolve(root, 'public', 'data.json');
const config = JSON.parse(await readFile(resolve(root, 'aleph.config.json'), 'utf8'));
if (![1, 2, 3, 4, 5].includes(config.step)) {
  throw new Error('이 빌드는 1~5단계만 지원합니다. 이후 단계의 빌드는 해당 단계에서 추가하세요.');
}
await mkdir(resolve(root, 'public'), { recursive: true });
if (config.step === 1) {
  const data = JSON.parse(await readFile(source, 'utf8'));
  if (!Array.isArray(data.notes)) {
    throw new Error('실습용 공개 자료 형식을 확인하세요. 실제 학생 자료를 넣으면 안 됩니다.');
  }
  await copyFile(source, output);
  console.log('실습용 공개 자료를 public/data.json에 복사했습니다.');
} else {
  // 2~5단계: 자료는 Supabase에 있고 /api/notes 서버 함수가 읽습니다. 공개 복사본은 만들지 않고, 남아 있으면 지웁니다.
  await rm(output, { force: true });
  console.log(`${config.step}단계: 공개 data.json을 만들지 않았습니다. 자료는 /api/notes 서버 함수가 읽습니다.`);
}
// 로그인은 서버 함수(/api/auth/*)가 하므로 브라우저용 Supabase SDK를 내려주지 않습니다. 예전 빌드의 복사본이 남아 있으면 지웁니다.
await rm(resolve(root, 'public', 'vendor'), { recursive: true, force: true });
if (!process.argv.includes('--local')) {
  const identity = deploymentIdentity(process.env, config);
  await writeFile(resolve(root, 'public', 'aleph.json'),
    `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  console.log('배포 저장소·커밋·주소를 public/aleph.json에 기록했습니다.');
}
