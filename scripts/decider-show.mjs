// 6단계 확인용: npm run decider:test 가 쓰는 것과 같은 가상 요청 두 건을 판정기에 넣고, 실제 판정 값을 보여 줍니다.
// 가상 요청 연습이며 심판 판정이 아닙니다. 미등록 기기 공격은 심판이 따로 보냅니다.
import { randomUUID } from 'node:crypto';
import { fixtureRequests } from './fixture-7.mjs';
import { decide } from '../src/decider.mjs';

const { normal } = fixtureRequests();
const cases = [
  ['등록 기기의 정상 요청', normal],
  ['미등록 기기의 가상 요청', { ...normal, requestId: randomUUID(), deviceRegistered: false }],
];
for (const [name, request] of cases) {
  const { decision, reasonCode, ruleIds } = await decide(request);
  process.stdout.write(`${name} (deviceRegistered: ${request.deviceRegistered}, ${request.method}) → ${decision} · ${reasonCode} · ${ruleIds.join(',')}\n`);
}
process.stdout.write('가상 요청 연습이며 심판 판정이 아닙니다.\n');
