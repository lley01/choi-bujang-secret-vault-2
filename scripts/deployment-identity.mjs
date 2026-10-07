const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[a-f0-9]{40}$/iu;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/iu;

// 5단계부터 배포 파일(/aleph.json)에 싣는 원본 자료 주소: https, 쿼리·조각(#)·계정 정보 없이. 비밀값이 섞이지 않게 막습니다.
function originalUrlOrNull(value) {
  if (typeof value !== 'string' || !value.startsWith('https://') || /[?#]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

export function deploymentIdentity(env, config) {
  const owner = env.VERCEL_GIT_REPO_OWNER;
  const repo = env.VERCEL_GIT_REPO_SLUG;
  const commit = env.VERCEL_GIT_COMMIT_SHA;
  const host = env.VERCEL_URL;
  if (env.VERCEL_GIT_PROVIDER !== 'github' || !OWNER.test(owner || '')
      || !REPO.test(repo || '') || repo === '.' || repo === '..'
      || repo.toLowerCase().endsWith('.git') || !SHA.test(commit || '')
      || !HOST.test(host || '') || ![1, 2, 3, 4, 5].includes(config?.step)
      || typeof config.judgeIssuer !== 'string'
      || !/^https:\/\/[a-z0-9-]+\.up\.railway\.app\/defense\/judge$/iu.test(config.judgeIssuer)
      || typeof config.sampleMarker !== 'string'
      || !/^[A-Z0-9_]{1,80}$/u.test(config.sampleMarker)) {
    throw new Error('배포 식별 정보를 확인할 수 없습니다. Vercel 시스템 환경변수와 aleph.config.json의 단계를 확인하세요.');
  }
  const originalApiUrl = config.step >= 5 ? originalUrlOrNull(config.originalApiUrl) : null;
  if (config.step >= 5 && !originalApiUrl) {
    throw new Error('5단계부터 aleph.config.json의 originalApiUrl에 쿼리 없는 https 원본 자료 주소가 필요합니다. 비밀값은 넣지 마세요.');
  }
  const identity = {
    schema: 'aleph.defense.deployment.v1',
    step: config.step,
    repoUrl: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
    commit: commit.toLowerCase(),
    publicAppUrl: `https://${host.toLowerCase()}`,
    judgeIssuer: config.judgeIssuer,
    sampleMarker: config.sampleMarker,
  };
  // 4단계 이하의 형식은 그대로 두고, 5단계부터 심판이 읽는 원본 자료 주소를 함께 싣습니다.
  if (originalApiUrl) identity.originalApiUrl = originalApiUrl;
  return identity;
}
