# BYTE BACK 방어전 시작 틀 R5

이 저장소는 1단계에서 학생 본인이 GitHub 저장소와 Vercel 배포를 만드는 출발점입니다. 포함된 메모 네 건은 가상 자료입니다. 실제 학생 자료, 토큰, 비밀키를 넣지 마세요.

## 4단계 저장점: 현재 작동하는 기능과 다시 실행하는 방법

**지금 되는 것**

- 이메일·비밀번호 로그인·로그아웃 화면(Supabase Auth 공식 SDK). 메모 API 다섯 경로는 모두 로그인 토큰을 시작 틀의 `src/verify-login.mjs`로 검사하고, 토큰이 없거나 틀리면 401 `{error, message}`로 거부합니다.
- **로그인해도 내 자료만**: 추가할 때 확인된 사용자 ID를 `owner_id`로 저장하고, 목록·한 건 조회·수정·삭제는 `owner_id = 확인된 ID`인 메모만 다룹니다. 남의 메모와 주인 없는 메모는 없는 메모와 같은 404입니다. URL·본문·헤더의 `owner_id`·`userId`는 읽지 않습니다.
- 공개 `data.json`은 없고 자료는 Supabase `public.notes`에 있습니다.

**`aleph.config.json` 대조**

| 항목 | 값 | 구현과 맞는지 |
|---|---|---|
| `step` | 4 | 소유자 검사까지 구현했습니다. 빌드·배포 식별·자기 점검이 4단계를 받도록 함께 넓혔습니다. |
| `repoUrl` | `https://github.com/lley01/choi-bujang-secret-vault-2` | Git `origin`과 같습니다. |
| `publicAppUrl` | `…-git-main-lley01.vercel.app/` | 알려 준 배포 주소입니다. 실제 배포에서 열어 확인한 값이 아닙니다. |
| `identityProvider` | `issuer`·`audience`·`jwksUrl` (공개 값) | 화면이 쓰는 Supabase 프로젝트와 같습니다(시험으로 확인). |
| `allowedRoutes` | `GET /api/notes`, `POST /api/notes`, `GET /api/notes/:id`, `PUT /api/notes/:id`, `DELETE /api/notes/:id` | `api/notes.js`·`api/notes/[id].js`가 처리하는 메서드·경로와 같습니다(시험으로 확인). |
| `judgeIssuer` | 운영 측이 채운 값 | 바꾸지 않았습니다. |
| `originalApiUrl` | `null` | 5단계부터 씁니다. |

**DB 권한**

- `public.notes`의 RLS 정책·최소 권한 SQL(`authenticated`에 SELECT·INSERT·UPDATE·DELETE, 모두 `auth.uid() = owner_id`)은 저장소 밖에서 제안했습니다. 실행했는지는 이 저장소로 확인할 수 없으니 Supabase SQL Editor의 확인 쿼리로 보세요.
- 앱 API는 서버 전용 키(`service_role`)로 접근해서 RLS를 건너뜁니다. API의 소유자 검사는 서버 코드(`src/notes-service.mjs`)가 합니다. 위 SQL을 실행했다면 로그인한 사용자가 Supabase REST를 직접 부르는 길이 열리고, 그 길에서는 RLS가 본인 행만 허용합니다.

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:stage4`, `test:notes-api`, `test:stage3`, `test:login-api`, `test:login`, `test:step2`
- 제출 묶음: 배포가 끝난 뒤 `npm run bundle`. 먼저 `bundle-notes.json`(커밋하지 않음)에 이번 단계에서 한 일을 적고, 변경을 커밋해 작업 폴더를 깨끗하게 둡니다. 이 점검은 `publicAppUrl`로 실제 요청을 보냅니다.
- 자기 점검(`src/attack-check.mjs`)은 심판의 판정이 아닙니다. 로그인 없는 요청의 거부 6건만 실제로 보내고, 로그인 토큰이 필요한 정상 로그인 점검과 사용자 두 명의 토큰이 필요한 "B가 A의 메모에 접근" 점검은 `미실행`으로 남깁니다.

**아직 하지 않은 것**

- 추가할 때 이미 있는 `id`면 409라서, 그 id가 쓰였다는 사실은 알 수 있습니다(내용은 알 수 없음). 호출 한도는 없습니다.
- `api/ai.js`·`api/threat-intel.js`는 501 뼈대 그대로이고, `RULE_IDS`는 시작 틀의 `starter.deny`만 있습니다.

## 추가: 4단계 제작 「API가 메모 주인을 확인합니다」

**작동하는 기능**

- 메모 API가 토큰 검사로 **확인된 사용자 ID**와 DB의 `owner_id`를 비교합니다. URL·쿼리·본문·헤더의 `owner_id`·`userId`는 읽지 않습니다.
- 추가(`POST /api/notes`): 확인된 ID를 `owner_id`로 저장합니다. 목록(`GET /api/notes`): 확인된 ID의 메모만 돌려줍니다.
- 한 건 조회·수정·삭제(`/api/notes/:id`): `id`와 `owner_id = 확인된 ID`를 **한 질의의 조건으로 함께** 겁니다. 확인하고 바꾸는 사이에 틈이 없습니다.
  - 수정은 기존 행의 주인이 본인일 때만 바꾸고, 새 행의 주인도 확인된 ID로 저장합니다. 돌려받은 행의 주인이 본인이 아니면 내용 없이 500으로 닫습니다.
  - 삭제도 본인 메모만 지웁니다.
- **남의 메모와 주인 없는 메모는 404**(`{"error":"NOT_FOUND"}`)로, 없는 메모와 똑같이 답합니다. 403 대신 404를 고른 이유는 그 id가 존재하는지조차 알려 주지 않기 위해서입니다.
- 응답 모양은 그대로입니다: 한 건은 `{id,title,body}`, 수정 본문은 `{title,body}`.
- `allowedRoutes`는 실제 경로와 이미 같아 바꾸지 않았습니다: `GET /api/notes`, `POST /api/notes`, `GET /api/notes/:id`, `PUT /api/notes/:id`, `DELETE /api/notes/:id`.

**아직 하지 않은 것**

- **DB 권한(RLS 정책)은 아직 그대로입니다.** 지금은 서버 전용 키로 접근하는 API 코드가 소유자를 확인합니다. DB 쪽 정책은 다음 요청에서 다룹니다.
- 추가할 때 이미 있는 `id`를 보내면 409(`ID_EXISTS`)라서, 그 id가 이미 쓰였다는 사실은 알 수 있습니다(내용은 알 수 없음).
- `src/attack-check.mjs`에는 "B가 A의 메모를 읽을 수 있는가" 점검이 없습니다. 사용자 두 명의 토큰이 있어야 해서 이 점검에서는 보낼 수 없습니다.
- (제작 시점의 기록) 이때는 `step`이 3이었습니다. 4단계 저장점에서 4로 올렸습니다.

**다시 실행하고 확인하는 방법**

- 로컬 시험: `npm run test:notes-api`
- 배포 뒤 정상: A로 로그인하면 A의 메모를 읽고 고치고 지울 수 있습니다.
- 배포 뒤 거부되어야 할 결과: A로 로그인한 화면에서 F12 → Console에 B 메모의 id로 요청을 보내면 404입니다(아래 예). B 메모와 A 메모 모두 DB에서 그대로입니다.
  - `(async()=>{const {data}=await window.supabase.createClient('https://iaifwhhyhzyacfdwziuo.supabase.co','sb_publishable_0s8RhycDB2bOIs4azTCLZQ_KoMi0l3j').auth.getSession();const r=await fetch('/api/notes/00000000-0000-4000-8000-0000000000b1',{headers:{Authorization:'Bearer '+data.session.access_token}});console.log(r.status,await r.json())})()`
  - id `00000000-0000-4000-8000-0000000000b1`은 4단계 준비 SQL(저장소 밖, Git에 올리지 않음)로 만든 「B의 시험 메모」입니다.

## 3단계 저장점 시점의 기록

(아래 표와 목록은 3단계 저장점 때의 값입니다. 지금 값은 맨 위 「4단계 저장점」을 보세요.)

**지금 되는 것**

- 이메일·비밀번호 **로그인·로그아웃 화면**(Supabase Auth 공식 SDK).
- 메모 API 다섯 경로가 모두 로그인 토큰을 시작 틀의 `src/verify-login.mjs`로 검사합니다. 토큰이 없거나 검사에 실패하면 자료 없이 **401**과 `{ error, message }`를 돌려주고, 서버 콘솔과 브라우저 콘솔에 그 사실이 남습니다.
- 로그인한 사용자가 메모를 **추가·수정·삭제**하고, 목록은 자기 메모만 보입니다. 추가할 때 서버가 확인한 사용자 ID를 `owner_id`로 저장합니다.
- 공개 `data.json`은 없고 자료는 Supabase `public.notes`에 있습니다.

**`aleph.config.json` 대조**

| 항목 | 값 | 구현과 맞는지 |
|---|---|---|
| `step` | 3 | 로그인·토큰 검사·허용 경로까지 구현했습니다. 빌드·배포 식별·자기 점검이 3단계를 받도록 함께 넓혔습니다. |
| `publicAppUrl` | `…-git-main-lley01.vercel.app/` | 알려 준 배포 주소입니다. 실제 배포에서 열어 확인한 값이 아닙니다. |
| `identityProvider` | `issuer`·`audience`·`jwksUrl` (모두 공개 값) | 화면이 쓰는 Supabase 프로젝트와 같은 프로젝트입니다(시험으로 확인). |
| `allowedRoutes` | 다섯 경로 | `api/notes.js`·`api/notes/[id].js`가 처리하는 경로와 같습니다(시험으로 확인). |
| `judgeIssuer` | 운영 측이 채운 값 | 바꾸지 않았습니다. |

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:stage3`, `test:notes-api`, `test:login-api`, `test:login`, `test:step2`
- 제출 묶음: 배포가 끝난 뒤 `npm run bundle`. 먼저 `bundle-notes.json`에 이번 단계에서 한 일을 적고, 변경을 커밋해 작업 폴더를 깨끗하게 둡니다. 이 점검은 `publicAppUrl`로 실제 요청을 보냅니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.
- `src/attack-check.mjs`는 심판의 판정이 아니라 학생의 자기 점검입니다. 로그인 없는 요청의 거부만 보내고, 정상 로그인 점검은 `미실행`으로 남깁니다.

**아직 하지 않은 것**

- (3단계 시점의 기록) 한 건 조회·수정·삭제(`/:id`)에 소유자 검사가 없었습니다. 4단계 제작에서 API가 주인을 확인하도록 고쳤습니다(위 「4단계 제작」).
- 호출 한도가 없고, `api/ai.js`·`api/threat-intel.js`는 501 뼈대 그대로입니다. `RULE_IDS`는 시작 틀의 기본 거부 규칙(`starter.deny`)만 있습니다.

## 추가: 로그인 없는 요청의 거부 응답과 콘솔 출력

**작동하는 기능**

- 로그인 토큰이 없거나 검사에 실패한 요청은 모든 메모 경로에서 **401**과 JSON 오류를 돌려줍니다: `{ "error": "LOGIN_REQUIRED", "message": "로그인이 필요합니다. 유효한 로그인 토큰과 함께 요청해 주세요." }`. `error`는 바뀌지 않는 코드이고 `message`는 사람이 읽는 설명입니다. 응답에는 `WWW-Authenticate: Bearer` 헤더가 붙습니다.
- 403이 아니라 401을 쓴 이유: 401은 "로그인(인증)이 안 됐다", 403은 "로그인은 했지만 권한이 없다"는 뜻입니다. 4단계에서는 남의 메모를 403이 아니라 404로 답하기로 했습니다(그 id가 있는지조차 알려 주지 않기 위해서).
- **서버 콘솔**: 거부될 때마다 로컬 터미널이나 Vercel Logs에 `NOTES_LOGIN_REQUIRED {"status":401,"method":"GET","route":"collection","body":{...}}` 한 줄이 남습니다. 토큰·헤더·요청 본문은 기록하지 않습니다.
- **브라우저 콘솔**: 화면의 API 호출이 거부되면 `GET /api/notes → HTTP 401 {error: ...}`처럼 상태와 JSON 오류가 남습니다. 또 로그인 영역의 **「로그인 없이 목록 요청해 보기」** 버튼은 일부러 로그인 정보 없이 `GET /api/notes`를 보내고 그 결과를 콘솔과 화면에 보여 줍니다. 거부되지 않고 자료가 돌아오면 경고만 하고 자료 내용은 출력하지 않습니다.

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:notes-api`와 `npm run test:login`
- 배포 뒤 정상: 브라우저에서 F12 → Console을 열고 점검 버튼을 누르면 `로그인 없이 GET /api/notes → HTTP 401 {error: "LOGIN_REQUIRED", message: ...}`가 노란색 경고로 나옵니다. 서버 쪽 줄은 Vercel 프로젝트의 Logs에서 `NOTES_LOGIN_REQUIRED`로 찾을 수 있습니다.
- 배포 뒤 거부되어야 할 결과: 위 401. 만약 HTTP 200이 나오면 로그인 검사가 빠진 것이니 배포를 확인하세요.

## 추가: 3단계 제작 3 「메모 추가·수정·삭제 화면과 서버 API, 허용 경로」

**작동하는 기능**

- 로그인한 사람이 화면에서 가상 메모를 **추가·수정·삭제**할 수 있습니다. 글은 모두 `textContent`로만 넣어 HTML 모양의 글도 코드로 실행되지 않습니다.
- 서버 API는 모두 먼저 로그인 토큰을 검사합니다(시작 틀의 `src/verify-login.mjs`, 고치지 않음). 공통 로직은 `src/notes-service.mjs`에 있고, `api/notes.js`와 `api/notes/[id].js`가 불러 씁니다.

| 요청 | 하는 일 | 응답 |
|---|---|---|
| `POST /api/notes` `{id?, title, body}` | 추가. `id`는 UUID이고 없으면 서버가 만듭니다. 서버가 확인한 사용자 ID를 `owner_id`로 저장합니다. | 201 `{id}` (중복 id는 409) |
| `GET /api/notes` | 로그인한 사용자의 메모 목록 | 200 `[{id,title,body}, ...]` |
| `GET /api/notes/:id` | 한 건 조회(본인 메모만) | 200 `{id,title,body}` (없거나 남의 메모면 404) |
| `PUT /api/notes/:id` `{title, body}` | 수정(본인 메모만). 주인은 확인된 본인 ID로 유지합니다. | 200 `{id,title,body}` (없거나 남의 메모면 404) |
| `DELETE /api/notes/:id` | 삭제(본인 메모만) | 204 (없거나 남의 메모면 404). 지운 뒤 GET은 404 |

- 토큰이 없거나 검사에 실패하면 모든 경로가 자료 없이 401(`{error, message}`)로 거부합니다. 잘못된 입력은 400(`INVALID_JSON`, `INVALID_TITLE`(제목 1~200자), `INVALID_NOTE_BODY`(본문 5000자 이하), `INVALID_ID`), 허용되지 않은 방법은 405입니다.
- 브라우저가 보낸 `userId`·`owner_id`·`role`은 읽지 않습니다. 신원은 토큰 검사 결과에서만 얻습니다.
- 테이블 칸 이름은 `content`이고 API에서는 `body`라고 부릅니다. 새 환경변수와 테이블 변경은 없습니다.
- `aleph.config.json`의 `allowedRoutes`에 위 다섯 경로를 `메서드 경로` 한 줄 모양으로 적었습니다. 이 모양은 `docs/DECIDER_REQUEST.md`의 `GET /notes/:id` 표기를 따른 것이며, `scripts/bundle.mjs`는 비어 있지 않은 배열인지만 확인합니다.

**아직 하지 않은 것 (알려진 약점)**

- **(해소됨) 소유자 검사가 없었습니다.** 제작 3 시점에는 로그인한 B가 A의 메모 id를 알면 읽고 고치고 지울 수 있었습니다. 4단계 제작에서 고쳤고, `test/notes-crud.test.mjs`의 허점 시험은 "B는 A의 메모를 다룰 수 없다(404)" 시험으로 바뀌었습니다.
- 주인(`owner_id`)이 비어 있는 메모는 목록에도, 한 건 경로에도 나오지 않습니다(404). 처음 넣어 둔 가상 메모를 쓰려면 Supabase SQL Editor에서 주인을 연결하거나, 화면에서 새로 추가하세요.
- 호출 한도가 없습니다. 심판 공개키(JWKS)나 Supabase를 확인하지 못하면 정상 로그인도 거부됩니다(자료 없이 닫힘).
- (제작 3 시점의 기록) 이때는 `step`이 2였습니다. 3단계 저장점에서 `step`을 3으로 올리고 `scripts/build-public.mjs`·`scripts/deployment-identity.mjs`·`src/attack-check.mjs`가 3단계를 받도록 넓혔습니다. `api/ai.js`와 `api/threat-intel.js`는 501 뼈대 그대로입니다.
- 실제 Vercel 배포와 실제 Supabase 계정으로 확인한 결과가 아닙니다. 아래 확인을 마치기 전까지는 미확인입니다.

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:notes-api` (전체는 `npm run test:login-api`, `npm run test:step2`, `npm run test:login`과 함께)
- 배포 뒤 정상: 로그인하면 「내 가상 메모」에서 추가·수정·삭제가 되고, 새로고침해도 내 메모가 남아 있습니다.
- 배포 뒤 거부되어야 할 결과: 로그인 없이 `/api/notes`를 요청하면 401(`LOGIN_REQUIRED`)이고, 제목이 빈 요청은 400입니다.

## 추가: 3단계 제작 2 「자료 API가 로그인 토큰을 검사합니다」

**작동하는 기능**

- `src/notes-service.mjs`(`api/notes.js`·`api/notes/[id].js`가 불러 씀)가 요청의 `Authorization: Bearer <토큰>`을 시작 틀의 `src/verify-login.mjs`(`createLoginVerifier`)로 검사합니다. 도우미는 고치거나 새로 만들지 않고 불러 쓰기만 합니다.
- 토큰이 없거나, 형식이 틀리거나, 검사에 실패하면 **자료 없이** 401(`LOGIN_REQUIRED`)로 거부합니다. 검사기를 만들 수 없는 설정 오류일 때도 자료를 주지 않고 500(`AUTH_UNAVAILABLE`)으로 닫습니다.
- 검사를 통과하는 것은 심판이 발급한 정상 로그인(예: A)과, Supabase에 로그인한 학생입니다. 신원은 검사 결과(`kind`, `userId`)에서만 얻고, 브라우저가 보낸 `userId`·`role`(헤더·쿼리·본문)은 읽지 않습니다.
- 화면은 로그인하면 세션 토큰을 `Authorization` 헤더에만 실어 `/api/notes`를 호출하고, 로그아웃하면 목록을 비웁니다. 로그인 전에는 자료 API를 부르지 않습니다(점검 버튼을 누를 때만 로그인 없이 한 번 요청합니다).
- `aleph.config.json`의 `identityProvider`에 검사에 쓰는 학생 로그인 발급자 정보(`issuer`·`audience`·`jwksUrl`)를 적었습니다. 모두 공개 값이며 비밀 키는 없습니다. 검사기가 요구하는 `publicAppUrl`(`https://….vercel.app/`)도 실제 배포 주소로 적었고, 심판 토큰의 대상은 이 주소의 호스트입니다.
- 새 환경변수는 없습니다. 기존 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`만 씁니다.

**아직 하지 않은 것 (알려진 약점)**

- (제작 2 시점의 기록) 이때는 로그인한 누구나 같은 메모 네 건을 봤고 소유 구분과 `allowedRoutes`가 없었습니다. 제작 3에서 목록은 사용자별이 되고 `allowedRoutes`가 채워졌습니다. 한 건 경로의 소유자 검사는 4단계 제작에서 붙었습니다.
- 호출 한도가 없습니다. 심판 공개키(JWKS)나 Supabase를 확인하지 못하면 정상 로그인도 거부됩니다(자료 없이 닫힘).
- `api/ai.js`와 `api/threat-intel.js`는 501 뼈대 그대로입니다.
- 실제 배포에서 심판·학생 로그인으로 확인한 것이 아닙니다. 아래 확인을 마치기 전까지는 미확인입니다.

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:login-api`
- 배포 뒤 정상: 로그인하면 자기 메모 목록이 보입니다(제작 3부터는 사용자별 목록).
- 배포 뒤 거부되어야 할 결과: 로그아웃 상태로 `/api/notes`를 열면 `{"error":"LOGIN_REQUIRED"}`(401)이고 메모는 없습니다.

## 추가: 3단계 제작 1 「이메일·비밀번호 로그인 화면」

**작동하는 기능**

- `/`에 Supabase Auth 이메일·비밀번호 **로그인·로그아웃 화면**이 있습니다. 공식 SDK(`supabase-js`)의 `signInWithPassword`와 `signOut`만 쓰고, 비밀번호나 JWT를 직접 만들지 않습니다.
- 로그인에 실패하면 화면에 이유(한국어 설명과 오류 코드)를 보여 줍니다. 예: 비밀번호 불일치, 이메일 미인증, 요청 과다, 네트워크 문제.
- SDK의 브라우저용 파일은 빌드가 `public/vendor/supabase.js`로 복사해 우리 서버에서 내려줍니다. 외부 CDN 스크립트는 쓰지 않고, 이 복사본은 Git에 올리지 않습니다(`.gitignore`).
- 화면 코드의 Project URL과 publishable key는 **공개용 값**입니다. 서버 전용 `SUPABASE_SECRET_KEY`는 지금처럼 Vercel 환경변수에만 둡니다.
- `vercel.json`이 모든 응답에 `X-Content-Type-Options: nosniff` 헤더를 붙입니다.

**아직 하지 않은 것 (알려진 약점)**

- (제작 1 시점의 기록) 이때는 로그인이 화면에만 붙어 있었고 서버는 토큰을 확인하지 않았습니다. 제작 2에서 서버가 토큰을 검사하게 되어 해소되었습니다.
- 로그인 세션은 SDK가 브라우저 저장소에 보관합니다. 이 화면은 외부 스크립트를 불러오지 않고 글을 `textContent`로만 넣지만, 화면에 코드가 끼어들 수 있게 되면 저장된 세션이 위험해집니다. 다음 제작 단계에서 함께 점검하세요.
- (제작 1 시점의 기록) 이때는 `step`이 2이고 `identityProvider`가 `null`이었습니다. 지금 값은 맨 위 「4단계 저장점」의 대조 표를 보세요.

**학생이 직접 하는 일**

1. Supabase 대시보드 → Authentication → Users에서 시험용 사용자를 만듭니다(Add user, 이메일 확인 건너뛰기를 켭니다). 비밀번호는 그 화면과 로그인 입력란에만 입력하고, 코드·Git·채팅에는 적지 않습니다.
2. Authentication → Sign In / Providers에서 Email이 켜져 있는지 확인합니다.

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:login`
- 로컬 화면 확인용 빌드: `npm run build -- --local` (SDK 복사까지 확인)
- 배포 뒤 정상: 시험용 이메일·비밀번호로 로그인하면 「로그인됨: 이메일」과 로그아웃 버튼이 보이고, 로그아웃하면 다시 입력란이 보입니다. 새로고침해도 로그인 상태가 유지됩니다.
- 배포 뒤 거부되어야 할 결과: 틀린 비밀번호는 이유가 화면에 보이고 로그인되지 않습니다. 빈 칸은 요청 없이 안내가 보입니다.

## 2단계 시점의 기록: 「자료를 코드 밖으로 옮깁니다」

(아래는 2단계를 끝냈을 때의 기록입니다. 지금의 API 응답 모양과 동작은 위의 「3단계 제작 3」을 보세요.)

**작동하는 기능**

- `/`는 `/api/notes`를 호출해 가상 메모 네 건을 보여 줍니다. 메모는 Supabase `public.notes` 테이블에 있고, 현재 코드·`data.json`·배포 파일에는 없습니다. (이전 커밋의 Git 기록에는 가상 메모가 남아 있습니다.)
- `api/notes.js`가 서버에서 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`로 테이블을 읽고, `title`과 `content`만 돌려줍니다. GET 이외의 요청은 405, 환경변수가 없으면 500(`SERVER_NOT_CONFIGURED`)입니다. 키는 응답과 로그에 나가지 않습니다.
- `/data.json`은 더 이상 배포되지 않습니다. 2단계 빌드는 공개 복사본을 만들지 않고, 남아 있으면 지웁니다.
- 테이블은 RLS를 켰고 `anon`·`authenticated`의 권한을 회수했습니다(당시 `supabase/step2_notes.sql`, 이 파일은 나중에 저장소에서 지웠습니다). 서버 전용 키를 가진 함수만 읽을 수 있습니다.

**처음 한 번, 학생이 직접 하는 일**

1. (2단계 당시) Supabase 학습용 프로젝트의 SQL Editor에서 `supabase/step2_notes.sql`을 실행했습니다. 이 SQL 파일은 나중에 저장소에서 지웠습니다.
2. Vercel 프로젝트의 Settings → Environment Variables에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY` 두 이름을 만들고, 값은 그 입력란에만 붙여넣습니다. 서버 전용 키는 코드·`public/`·`NEXT_PUBLIC_` 이름·Git·캡처 화면에 넣지 않습니다. 저장한 뒤 Redeploy를 누릅니다.

**다시 실행하고 확인하는 방법**

- 키 없이 하는 로컬 시험(가짜 값 사용): `npm run test:step2`
- 배포 뒤 정상: `/`에 메모 네 건이 보이고, `/api/notes`가 `{ "notes": [...] }` 형식의 JSON을 돌려줍니다.
- 배포 뒤 거부되어야 할 결과: `/data.json`은 404, `/api/notes`에 POST를 보내면 405, Supabase 주소에 `anon` 키로 `notes` 테이블을 직접 요청하면 권한 오류입니다.

**알려진 약점 (2단계 시점의 기록. 첫 항목은 3단계 제작 2에서 해소됨)**

- **(해소됨) `/api/notes`는 공개 주소였습니다.** 2단계 시점에는 로그인, 호출 한도, 허용 경로가 없어서 주소를 아는 누구나 가상 메모를 읽을 수 있었습니다. 지금은 로그인 토큰 검사가 붙었습니다(위 「3단계 제작 2」). 호출 한도와 허용 경로는 아직 없습니다.
- 이 함수에는 자료 조회 외의 기능이 없지만, 실제 학생 자료나 이름이 들어가기 전에 반드시 위 약점을 먼저 막아야 합니다. 지금은 가상 메모만 넣으세요.
- `src/attack-check.mjs`의 2단계 점검은 배포 주소로 실제 보낸 요청의 결과만 기록하며 심판의 판정이 아닙니다. 아직 실제 배포에서 실행하지 않았다면 미실행입니다.

## 학생이 하는 일: 세 걸음 (1단계 시작 틀 기준)

1. GitHub 계정을 만듭니다.
2. 방어전 1단계 카드의 **Deploy** 버튼을 누릅니다. Vercel에 GitHub로 로그인하고, 새 저장소가 **본인 계정의 Public 저장소**인지 확인한 뒤 Deploy를 누릅니다.
3. 배포가 끝나면 화면에 나온 `https://…vercel.app` 주소를 방어전 1단계 카드에 붙여넣고 제출합니다. 저장소 주소나 설정 파일은 적지 않습니다.

1단계 시작 틀에서는 배포가 끝나면 `/`에서 점령된 가상 자료실을 볼 수 있고, `/data.json`에는 같은 가상 메모가 공개됩니다. 이 공개 상태를 확인하는 것이 1단계의 출발점이었습니다. 2단계 이후의 현재 동작은 맨 위 「4단계 저장점」을 따릅니다. 1단계 접수와 심판 판정은 포털에서 확인합니다.

## 시작 틀의 자동 처리

`vercel.json`은 정적 결과물 `public`을 배포합니다. 빌드 명령 `npm run build`는 Vercel이 제공하는 GitHub 저장소 소유자·이름, 커밋 SHA, 배포 URL을 검증하고 `public/aleph.json`을 생성합니다. 이 값이 없으면 빌드가 실패하므로, 성공한 것처럼 빈 주소를 내보내지 않습니다. `aleph.json`의 내용만으로 저장소 소유권이나 방어 성공을 인정하지 않습니다. 심판이 공개 저장소의 실제 커밋과 배포된 자료를 따로 대조해야 합니다.

시작 틀에서 `aleph.config.json`의 `repoUrl`과 `publicAppUrl`은 이전 제출 묶음 방식의 자리표시자였고, 1단계에서는 학생이 편집하지 않았습니다. 지금은 실제 값이 들어 있습니다(맨 위 대조 표). 2단계 이후 코딩 도구가 필요한 설정과 보호 기능을 단계별로 작성합니다. `npm run bundle`과 `bundle-notes.json`도 1단계의 세 걸음에는 포함되지 않습니다.

로컬에서 가상 화면만 확인할 때는 `npm run build -- --local`을 사용합니다. 로컬 실행은 Vercel 배포나 심판 접수를 증명하지 않습니다. 저장소의 `src/attack-check.mjs`는 실제 배포가 된 뒤 비로그인으로 요청해 결과를 기록합니다(1단계는 `/data.json`의 확인 표시, 2단계 이후는 `/data.json`이 없는지와 `/api/notes`가 토큰 없는 요청·엉터리 토큰 요청을 자료 없이 거부하는지). 정상 로그인 요청은 학생 비밀번호나 심판 토큰이 필요해 이 점검에서 보내지 않습니다.

## 다음 단계의 코딩 도구에 전달할 규칙

[AGENTS.md](AGENTS.md)를 먼저 읽히고 한 번에 한 제작 단위만 요청하세요. 2단계부터는 자료 보호를 구현할 때 `public/data.json`을 복사하는 1단계 빌드 흐름도 함께 바꿔야 합니다. 3단계 이후의 로그인, 허용 경로, 5단계의 원본 API 주소, 6단계 이후 정책 규칙은 해당 단계 원고와 계약에 맞춰 추가합니다. 비밀번호·토큰·서버 전용 키·실제 학생 기록을 코드, Git, 제출 묶음에 넣지 않습니다.

`src/decider.mjs`와 `src/detect.mjs`의 로컬 시험은 반 엔진이나 운영 심판의 결과가 아닙니다. 1단계 이후 제출 묶음 계약 `aleph.defense.submission.v2`는 `scripts/bundle.mjs`에 남아 있으며, 코딩 도구가 해당 단계의 최신 배포 주소와 Git 원격을 맞춘 뒤 사용합니다.
