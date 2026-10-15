# BYTE BACK 방어전 시작 틀 R5

이 저장소는 1단계에서 학생 본인이 GitHub 저장소와 Vercel 배포를 만드는 출발점입니다. 포함된 메모 네 건은 가상 자료입니다. 실제 학생 자료, 토큰, 비밀키를 넣지 마세요.

## 추가: 11단계 기기 승인 — 승인 요청·서버 확인 뒤에만 자료실 열기

**흐름** (기기 키는 WebAuthn 패스키: 개인키는 이 기기의 인증 장치 안에만 있고 브라우저 저장소에 넣지 않음)

1. 로그인하면 화면이 서버(`GET /api/devices/status`)에 이 기기 상태를 묻습니다. 서버가 확인하기 전에는 메모 목록·추가 칸을 숨기고 `/api/notes`를 요청하지도 않습니다.
2. **이 기기 승인 요청**: 서버의 일회용 챌린지로 이 기기에 패스키를 만들고 공개키만 보냅니다(`POST /api/devices/challenge` → `register`). 서버는 이 사이트에서 만든 키인지(챌린지·출처·rpId·사용자 확인 플래그·자격 ID·P-256 공개키) 확인한 뒤 `user_devices`에 **승인 대기(pending)** 로만 저장합니다. 이 버튼은 권한을 주지 않습니다.
3. **승인**: 승인 API는 없습니다. 학생이 Supabase SQL Editor에서 화면에 보이는 16자리 기기 ID를 넣어 `status = 'approved'`로 바꿉니다(`step11_user_devices.sql`의 2) 부분).
4. **이 기기로 열기**: 서버 챌린지에 이 기기가 서명하고(`challenge` → `verify`), 서버가 저장된 공개키로 서명을 검증하고 DB에서 그 기기가 **이 사용자의 승인된 기기**인지 확인한 뒤에만 15분짜리 기기 세션 쿠키(`aleph_dev`, HttpOnly·Secure·SameSite=Strict, 서버 HMAC 서명)를 줍니다. 그때 화면이 「승인됨 — 서버가 이 기기의 서명과 승인 상태를 확인했습니다」로 바뀌고 자료실이 열립니다.
5. 메모 API(`/api/notes`, `/api/notes/:id`)와 복원 API는 화면 로그인 요청마다 기기 세션의 서명·만료·사용자를 보고 **DB에서 지금도 승인 상태인지 다시 확인**합니다. 없거나 맞지 않으면 403 `DEVICE_NOT_APPROVED`(자료 없음). 승인을 취소(`revoked`)하면 다음 요청부터 막힙니다.

| 화면 「기기 승인」 표시 | 뜻 |
|---|---|
| 미승인 | 이 계정으로 요청한 기기가 없음 |
| 승인 대기 | 요청했고 서버(SQL) 승인을 기다림. 자료실 닫힘 |
| 확인 전 | 승인된 기기가 있으나 이 기기의 서명을 아직 확인하지 않음 |
| 승인됨 — 서버가 … 확인했습니다 | 서버 상태 응답(`current`)이 있을 때만. 자료실 열림 |
| 승인 취소됨 | 서버에서 취소됨. 자료실 닫힘 |

- 서명 검증은 외부 라이브러리 없이 Node `crypto`로 합니다(ES256). 서명 횟수가 되돌아가면 거부하고, 챌린지는 2분 안에 한 번만 씁니다.
- 기기 세션 서명 키는 서버 전용 `SUPABASE_SECRET_KEY`에서 HKDF로 따로 만듭니다(새 환경변수 없음). 키·서명·세션·공개키 원문은 로그에 남기지 않습니다.
- 로그아웃하면 기기 세션 쿠키도 지웁니다(승인 자체는 서버에 남음).
- 심판 토큰(Authorization 헤더, kind `judge`)으로 온 요청은 반 엔진이 기기 등록을 먼저 확인하므로(판정기 `device_registered`) 앱에서 다시 묻지 않습니다.
- 새 서버 함수 `api/devices/[action].js`를 패키징 기준표에 더했습니다. 기기 경로는 화면 전용이라 판정기 허용 경로(`allowedRoutes`)에는 넣지 않았습니다(로그인 경로와 같음).

**준비(학생이 직접)**: 저장소 밖의 `step11_user_devices.sql`을 검토해 SQL Editor에서 실행합니다(테이블 `public.user_devices`, 브라우저 역할 권한 없음, 서버도 삭제 불가). 커밋하지 않습니다.

**아직 하지 않은 것 / 주의**

- 패스키를 계정과 동기화하는 브라우저(예: 같은 계정의 다른 기기)에서는 같은 키가 다른 기기에도 있을 수 있습니다. 승인은 그 키 단위입니다.
- 실제 배포 주소·실제 Supabase에서는 아직 확인하지 않았습니다(미실행). 로컬에서 실제 서버 함수 코드와 가짜 DB, Chromium 가상 인증 장치로 1) 미승인 때 자료 없음 2) 승인 요청 뒤에도 닫힘(직접 요청 403) 3) SQL 승인 흉내 + 열기 뒤 열림 4) 승인 취소 뒤 닫힘 5) 브라우저 저장소 비어 있음을 확인했습니다.

**다시 확인하는 방법**

- `node --test test/stage11-device.test.mjs` (실제 P-256 키로 패스키 등록·서명을 흉내 낸 서버 검증 시험, 심판 판정 아님)
- 배포 뒤(SQL 실행 후): 로그인 → 「이 기기 승인 요청」(기기 잠금 확인 창) → 표시가 「승인 대기」이고 메모가 보이지 않음 → SQL로 승인 → 「이 기기로 열기」 → 「승인됨」과 메모 목록. F12 → Application에서 Local/Session Storage·IndexedDB가 비어 있어야 합니다.

## 추가: 11단계 「나만의 접속 앱을 완성합니다」— 설치형 웹앱과 앱·기기 상태

**step 11**

- `aleph.config.json`의 `step`을 11로 올렸고, 빌드·배포 식별·자기 점검이 1~11단계를 받습니다(12단계 이상 거부). `/aleph.json`의 형식은 10단계와 같습니다(`restoreRoute` 포함).

**작동하는 기능** (지금 배포 중인 자료실 화면에 붙임, 따로 설치하는 접속 프로그램은 없음)

| 파일 | 하는 일 |
|---|---|
| `public/manifest.webmanifest` | 앱 이름 「BYTE BACK 내 자료실」, 짧은 이름 「내 자료실」, `standalone` 창, 시작 주소 `/`, 아이콘 192·512 |
| `public/icons/icon-192.png`, `icon-512.png` | 앱 아이콘(외부 주소 없음) |
| `public/offline.html` | 오프라인 안내: 메모는 서버에만 있어 오프라인에서는 보거나 저장할 수 없음, 설치만으로 기기 확인이 끝나지 않음 |
| `public/sw.js` | 화면 이동이 **네트워크 오류로 실패할 때만** 오프라인 안내를 보여 줌. 저장하는 것은 오프라인 안내·manifest·아이콘뿐이고, 첫 화면과 메모 API(`/api/…`)는 가로채거나 저장하지 않음 |
| `public/index.html` | manifest·아이콘 연결, 「앱·기기 상태」 칸(실행 방식·기기 승인·네트워크) |
| `vercel.json` | `/sw.js`는 `Cache-Control: no-cache`, manifest는 `application/manifest+json`. `nosniff`는 그대로 |

- **실행 방식**: 브라우저 탭인지, 설치한 앱 창(`display-mode: standalone`)인지 보여 줍니다. 앱 창이어도 「설치는 기기 확인이 아님」이라고 함께 적습니다.
- **기기 승인**: (고침) 아래 「11단계 기기 승인」에서 서버가 확인한 상태만 보여 주도록 바꿨습니다. 설치 여부는 이 표시를 바꾸지 않습니다.
- **네트워크**: 온라인/오프라인. 오프라인이면 「메모를 불러오거나 저장할 수 없습니다」라고 안내합니다.

**아직 하지 않은 것**

- (고침) 기기 승인 상태 표시는 아래 「11단계 기기 승인」에서 붙였습니다.
- 실제 배포 주소에서의 설치·오프라인 확인은 이 작업 공간에서 하지 못했습니다(미실행). 로컬에서 띄운 같은 파일로 Chromium에서 manifest 설치 조건 오류 0건, 서비스 워커가 메모 API를 가로채지 않음, 서버가 꺼졌을 때 오프라인 안내가 뜨는 것을 확인했습니다.

**다시 확인하는 방법**

- `npm run test:stage11` (브라우저 없이 파일과 서비스 워커 동작 시험, 심판 판정 아님)
- 배포 뒤: Chrome에서 자료실을 열고 F12 → Application → Manifest에 이름·아이콘이 보이고 설치 관련 오류가 없는지, Service workers에 `/sw.js`가 활성인지 확인합니다. 주소창의 설치 아이콘으로 설치해 앱 창으로 열면 실행 방식이 「설치한 앱 창(설치는 기기 확인이 아님)」, 기기 승인 표시는 설치 전과 같아야 합니다(설치로 바뀌지 않음). Network 탭에서 Offline을 켜고 새로고침하면 「지금은 오프라인입니다」 안내가 떠야 합니다.

## 고침: `step` 10과 빌드 단계 범위

- `aleph.config.json`의 `step`을 10으로 올렸습니다. 빌드(`scripts/build-public.mjs`)·배포 식별(`scripts/deployment-identity.mjs`)·자기 점검(`src/attack-check.mjs`)이 1~10단계를 받고, 11단계 이상은 거부합니다.
- 10단계부터 배포 파일 `/aleph.json`에 `restoreRoute`(`POST /api/restore/:id`)를 함께 싣습니다. 형식(`메서드 경로`)이 틀리거나 `allowedRoutes`에 없으면 빌드를 멈춥니다. 9단계 이하의 `/aleph.json` 형식은 그대로입니다.
- 자기 점검의 `normal_identity_after_restore`는 10단계부터 배포된 `/aleph.json`의 `restoreRoute`가 설정과 같은지도 확인합니다.
- 다시 확인: `npm run test:stage10`. 배포가 Ready가 되면 `/aleph.json`에 `"step": 10`과 `"restoreRoute": "POST /api/restore/:id"`가 보여야 합니다(이 작업 공간에서는 배포 주소를 열 수 없어 미확인).

## 10단계 안전 사본 복원 절차(정리)

복원은 두 가지입니다. ① 시험 정책(`aleph.config.json`의 허용 경로)을 안전 정책 사본으로 되돌리기, ② 비공개 가상 메모 사본(`public.notes_backup`)에서 메모 한 건 복원. 아래 순서를 지키고, **실행하지 않은 시험은 결과를 지어내지 말고 「미실행」으로 남깁니다.**

### 1. 적용 전: 사본 버전 다시 검증

| 사본 | 버전 표시 | 적용 직전에 다시 검증하는 것 | 실패하면 |
|---|---|---|---|
| 안전 정책 사본(JSON 파일) | 침해 전에 따로 기록해 둔 SHA-256 지문 | `npm run policy:restore`가 **실행할 때마다**(미리보기와 `--apply` 모두) 사본 파일의 SHA-256을 다시 계산해 기록한 지문과 비교하고, 형식(`aleph.policy.v1`)도 다시 확인 | 미리보기도 하지 않고 중단(종료 코드 1) |
| 메모 사본(`notes_backup` 한 행) | `content_sha256`(제목 + 0x00 + 본문의 SHA-256), `backed_up_at` | 복원 요청마다 DB 함수가 같은 트랜잭션 안에서 ① 사본 ID = 경로 ID ② 사본 소유자 = 로그인한 사용자 ③ 사본 내용으로 다시 계산한 해시 = 저장된 해시 = 요청의 `contentSha256`을 확인 | 404·409로 거부하고 아무것도 바꾸지 않음(감사 기록만 한 줄) |

- 지문은 사본 파일 안이 아니라 명령 인자로 받습니다. 사본을 바꾼 사람이 지문까지 다시 계산해 넣어도 기록과 달라 통과하지 못합니다.
- 메모 사본을 적용하기 전에 SQL Editor에서 사본이 훼손되지 않았는지 직접 볼 수 있습니다(읽기만 함). `intact`가 `true`여야 합니다.
  ```sql
  select id, backed_up_at, content_sha256,
         encode(sha256(convert_to(title, 'UTF8') || '\x00'::bytea || convert_to(content, 'UTF8')), 'hex') = content_sha256 as intact
    from public.notes_backup;
  ```
- 시험 정책 되돌리기는 **미리보기 → 확인 코드로 실행** 두 번에 나눕니다. 확인 코드는 사본 지문·서비스·바뀌기 전후 허용 경로로 만들어서, 미리보기 뒤에 사본이나 설정이 바뀌면 코드가 맞지 않아 중단합니다.

### 2. 변경 범위

| 복원 | 바뀌는 것 | 바뀌지 않는 것 |
|---|---|---|
| ① 시험 정책 | `aleph.config.json`의 `allowedRoutes` 중 `--service`로 고른 서비스(`/api/<서비스>/…`)의 경로만. `audit/policy-restore.jsonl`에 한 줄 덧붙임(바뀐 것이 없으면 쓰지 않음) | 다른 서비스 경로와 순서, 설정의 다른 항목(`step`·`judgeIssuer` 등)과 줄바꿈, 판정기 규칙 코드(`src/decider.mjs`, 「! 직접 확인」으로만 알림), 기존 감사 줄, Supabase·Vercel 설정 |
| ② 메모 한 건 | `public.notes`에서 그 ID 한 행의 제목·본문(지워졌으면 그 한 행을 다시 만듦). `public.notes_restore_audit`에 시도마다 한 줄 덧붙임 | 다른 메모, 지금 주인이 다른 사람인 메모(덮어쓰지 않음), `notes_backup`, 기존 감사 기록(서버 전용 키로도 수정·삭제 불가), 다른 테이블·권한 |

- ①로 바뀐 설정과 감사 줄은 학생이 검토해 커밋·배포해야 반영됩니다. ②는 DB에 바로 반영됩니다.

### 3. 복원 뒤: 정상·금지 요청 다시 시험

배포가 Ready가 된 뒤 아래를 다시 시험합니다. 결과 칸에는 **실제로 보낸 요청의 응답만** 적습니다.

**자동(`npm run bundle`의 자기 점검이 배포 주소에 실제로 보냄)**

| 구분 | 점검 ID | 요청 | 기대 |
|---|---|---|---|
| 금지 | `anonymous_note_read` | `GET /data.json` | 메모가 보이지 않음 |
| 금지 | `anonymous_notes_api_read`, `forged_token_notes_api_read` | 토큰 없이·엉터리 토큰으로 `GET /api/notes` | 401 `LOGIN_REQUIRED` |
| 금지 | `anonymous_note_create`·`_update`·`_delete` | 토큰 없이 `POST /api/notes`, `PUT`·`DELETE /api/notes/<무작위 ID>` | 401 `LOGIN_REQUIRED` |
| 금지 | `restore_anonymous_after_restore`, `restore_forged_token_after_restore` | 토큰 없이·엉터리 토큰으로 `POST /api/restore/<무작위 ID>` | 401 `LOGIN_REQUIRED` |
| 금지 | `restore_cross_site_after_restore` | 다른 사이트 `Origin`으로 같은 요청 | 403 `CROSS_SITE_REQUEST` |
| 금지 | `restore_wrong_method_after_restore` | `GET /api/restore/<무작위 ID>` | 405 `METHOD_NOT_ALLOWED` |
| 정상 | `normal_screen_after_restore` | `GET /` | 200, 자료실 화면 |
| 정상 | `normal_identity_after_restore` | `GET /aleph.json` | 200, 현재 `step`, 허용 경로에 `POST /api/restore/:id` |

- 우리 앱의 JSON 오류 코드일 때만 「거부됨」입니다. 앱이 아닌 곳이 막은 401·403은 「판정 불가」, 그 밖은 「예상대로 거부되지 않음」으로 그대로 남습니다. 금지 요청은 무작위 ID와 0으로 채운 해시를 써서 실제 메모를 복원하지 않습니다.

**로컬(키·네트워크 없이)**

- `npm run policy:diff -- <사본> <지문>`: ①로 되돌린 서비스의 허용 경로 차이가 사라졌는지(다른 서비스·규칙 차이는 남아 있을 수 있음).
- `node --test test/*.test.mjs`, `npm run decider:test`, `npm run detect:test`: 판정기·탐지 규칙이 그대로인지. 가상 요청 연습이며 심판 판정이 아닙니다.

**학생이 직접(시험 계정 B·A로, 위 「시험 계정 B로만 확인하기」 순서)**

- 정상: B가 자기 메모를 복원하면 200 `{ restored: true }`, 새로고침하면 사본 내용.
- 금지: 해시를 바꾸면 409 `HASH_MISMATCH`, A가 같은 요청을 보내면 404 `NOT_FOUND`. 두 경우 모두 메모는 그대로.
- 감사: `notes_restore_audit`에 시도마다 한 줄씩 쌓이고, A의 메모는 그대로.
- 이 결과는 직접 본 것만 `bundle-notes.json`에 적습니다. 하지 않았으면 적지 않습니다.

**미실행으로 남는 시험** (토큰·엔진 정보가 필요해 자기 점검이 요청을 보내지 않음. 결과 칸에 「미실행:」으로 남음)

| 점검 ID | 이유 |
|---|---|
| `normal_login_notes_read` | 정상 로그인 토큰 필요 |
| `other_owner_note_access` | 서로 다른 두 사용자의 토큰 필요 |
| `direct_db_rest_access` | 로그인 토큰과 학습 DB 주소 필요(DB 권한은 SQL 확인 쿼리로 확인) |
| `unregistered_device_notes_read` | 반 엔진의 기기 정보 필요(심판이 보냄) |
| `step_up_reauth_notes_read` | 엔진의 다시 로그인 확인 계약이 아직 없음 |
| `doppelganger_device_revocation` | 실제 회수와 걸린 시간은 심판이 확인 |
| `restore_owner_flow_needs_login` | B·A 토큰과 사본 해시 필요(위 「학생이 직접」으로 확인) |

- 이 작업 공간에서는 배포 주소와 실제 Supabase에 요청을 보낼 수 없어서, 위 자동 재시험과 B 계정 확인은 아직 실행하지 않았습니다(미실행). SQL은 로컬 PostgreSQL 16에서만 확인했습니다.

## 추가: 7단계 제작 1 「접속 정보의 출처를 구분합니다」(입력 검사만)

**작동하는 기능**

- `src/decider.mjs`의 `readAccessContext(request)`가 엔진이 넘긴 접속 정보를 출처별로 읽습니다. 판정 규칙과 `RULE_IDS`는 바꾸지 않았고, 판정 결과도 6단계와 같습니다.

| 입력 | 출처(`source`) | 지역·네트워크·시각 |
|---|---|---|
| `signals.source: 'judge_fixture'` | 심판의 가상 접속 정보(`virtual: true`, 실제 위치 증거 아님) | 형식이 맞는 값만 읽음(`unknown`·빈 값·틀린 형식은 `null`) |
| `signals.source: 'none'`(현재 실제 경로) | `none` | 모두 `null` |
| 그 밖의 출처, 대소문자·공백이 다른 값, 항목이 더하거나 빠진 `signals`, `signals` 없음 | `unclear` | 모두 `null` |
| 계약 18개 이름 밖의 항목이 섞인 요청(예: `headers`, `x-forwarded-for`, `geo`, `region`) | `unclear` | 모두 `null`. 섞인 항목의 값은 읽지 않음 |

- 행동(`recentEvents`)은 엔진이 넘긴 배열(최대 12건, 각 `{kind, ageSeconds, count}`)일 때만 읽습니다. `[]`은 "사건 없음"이고, 값이 없거나 형식이 틀리면 `null`(모름)입니다.
- 모르는 값은 `missing`에 적고, `local`·`usual`·현재 시각 같은 정상값으로 채우지 않습니다. 따라서 위조한 클라이언트 헤더가 신뢰하는 접속 정보로 올라가지 않습니다.

**다시 확인하는 방법**: `npm run test:stage7` (가상 요청 시험이며 심판 판정이 아닙니다)

## 추가: 10단계 제작 3 「비공개 사본에서 메모 한 건 복원」

**서비스·경로**

| 서비스 | 경로 | 요청 본문 | 응답 |
|---|---|---|---|
| `restore` | `POST /api/restore/:id` | `{ "contentSha256": "사본의 내용 해시(64자리)" }` | 200 `{ id, restored: true }` |

- `aleph.config.json`의 `restoreRoute`와 `allowedRoutes`에 `POST /api/restore/:id`를 적었고, 판정기 구역 규칙에 `restore` 구역(`POST /restore/:id`만 허용)을 더했습니다.
- 서버 함수: `api/restore/[id].js` → `src/restore-service.mjs`. 패키징 기준표(`package/baseline-functions.json`)에도 더했습니다.

**작동하는 기능**

- 비공개 사본은 Supabase의 `public.notes_backup` 테이블입니다(RLS 켜짐, 정책 없음, PUBLIC·anon·authenticated 권한 없음, 서버 전용 키만 읽음). 화면·브라우저는 사본을 볼 수 없습니다.
- 로그인은 메모 API와 같은 검사기로 확인하고, DB 함수 `restore_note_from_backup`이 한 트랜잭션에서 대조합니다: ① 사본 ID = 경로 ID, ② 사본 소유자 = 로그인으로 확인한 사용자, ③ 사본 내용으로 다시 계산한 해시 = 사본에 저장된 해시 = 요청의 `contentSha256`. 내용 해시는 `SHA-256(제목 + 0x00 + 본문)`입니다.
- 모두 맞으면 **그 한 건만** 사본 내용으로 되돌립니다(지워졌으면 다시 만듦). 지금 그 메모의 주인이 다른 사람이면 덮어쓰지 않습니다. 다른 메모는 건드리지 않습니다.
- 결과와 관계없이 `public.notes_restore_audit`에 한 줄(메모 ID·요청자·요청 해시·결과·시각)을 덧붙입니다. 이 표는 덧붙이기만 되고, 서버 전용 키로도 고치거나 지울 수 없습니다.
- 요청 본문에서는 `contentSha256`만 읽습니다(제목·본문·owner_id·role 무시). 다른 사이트에서 보낸 요청은 403입니다.
- 거부: 로그인 없음 401, 잘못된 ID·해시·JSON 400, 남의 사본·없는 사본·남의 메모 404(있다는 사실도 알리지 않음), 해시 불일치 409 `HASH_MISMATCH`, 사본 훼손 409 `BACKUP_INTEGRITY_FAILED`. 서버 로그에는 `RESTORE_DENIED {"reason":"…"}`처럼 짧은 사유만 남기고 ID·토큰·본문은 남기지 않습니다.

**준비(학생이 직접)**: 저장소 밖에서 받은 `step10_notes_restore.sql`을 검토한 뒤 Supabase SQL Editor에서 실행합니다. 사본에는 시험 계정 B의 시험 메모(`…0000000000b1`) 한 건만 들어가고, 마지막 표에 그 메모의 `content_sha256`이 보입니다(SQL 파일은 커밋하지 않음).

**시험 계정 B로만 확인하기** (배포 주소에서)

1. b@example.com으로 로그인해 「B의 시험 메모」 내용을 아무렇게나 고쳐 저장합니다(훼손 흉내).
2. F12 → Console에서 아래를 실행합니다(`<해시>`는 SQL 결과의 `content_sha256`).
   ```js
   fetch('/api/restore/00000000-0000-4000-8000-0000000000b1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentSha256: '<해시>' }) }).then((r) => r.json()).then(console.log)
   ```
   정상: `{ id: '00000000-…b1', restored: true }`, 새로고침하면 B의 메모가 원래 내용으로 돌아옵니다.
3. 거부 확인: 해시 끝 한 글자를 바꿔 보내면 409 `HASH_MISMATCH`이고 메모는 그대로입니다. a@example.com으로 로그인해 같은 요청을 보내면 404 `NOT_FOUND`입니다.
4. SQL Editor에서 `select note_id, outcome, at from public.notes_restore_audit order by audit_id;`로 시도마다 한 줄씩 쌓였는지, A의 메모가 그대로인지 확인합니다.

**아직 하지 않은 것**

- 화면 메뉴는 없습니다. 사본은 B의 시험 메모 한 건뿐이고, 사본을 새로 만드는 경로도 없습니다.
- (고침) `step`은 아래 「step 10과 빌드 단계 범위」에서 10으로 올렸습니다.

**복원 뒤 다시 시험(자기 점검, `npm run bundle`)** — (고침) 처음에는 복원 경로에 요청을 하나도 보내지 않고 미실행 한 줄만 적었습니다.

복원을 마치고 배포가 끝난 뒤 `npm run bundle`을 실행하면, 배포 주소에 아래 요청을 **실제로 보내고 받은 응답만** 적습니다.

| 점검 | 보내는 요청 | 거부로 적는 조건 |
|---|---|---|
| `restore_anonymous_after_restore` | 토큰 없이 `POST /api/restore/<무작위 ID>` | 401 `LOGIN_REQUIRED` |
| `restore_forged_token_after_restore` | 엉터리 토큰으로 같은 요청 | 401 `LOGIN_REQUIRED` |
| `restore_cross_site_after_restore` | 다른 사이트 `Origin`으로 같은 요청 | 403 `CROSS_SITE_REQUEST` |
| `restore_wrong_method_after_restore` | `GET /api/restore/<무작위 ID>` | 405 `METHOD_NOT_ALLOWED` |
| `normal_screen_after_restore` (정상) | `GET /` | 200이고 자료실 화면 제목이 보임 |
| `normal_identity_after_restore` (정상) | `GET /aleph.json` | 200, 현재 `step`, 허용 경로에 `POST /api/restore/:id` |

- 금지 요청은 무작위 메모 ID와 0으로 채운 해시를 써서, 거부되지 않더라도 실제 메모는 복원되지 않습니다. 우리 앱의 JSON 오류 코드일 때만 「거부됨」이고, 앱이 아닌 곳이 막은 401·403은 「판정 불가」, 그 밖은 「예상대로 거부되지 않음」으로 그대로 적습니다.
- 로그인 토큰이 필요한 시험(B의 정상 복원, 복원한 메모 다시 읽기, A의 B 메모 복원 거부)은 보내지 않았으므로 `restore_owner_flow_needs_login`에 **미실행**으로 남깁니다. 위 「시험 계정 B로만 확인하기」 순서로 직접 확인하고, 그 결과는 `bundle-notes.json`에 직접 적습니다.
- 점검 결과는 모두 19개입니다(제출 묶음 한도 20개).

**다시 확인하는 방법**: `npm run test:stage10` (DB 함수와 배포 응답은 가짜로 흉내 냅니다. 실제 SQL과 배포는 따로 확인)

## 추가: 10단계 제작 2 「안전 정책 사본으로 시험 정책 되돌리기」

**작동하는 기능** — 두 번에 나눠 실행합니다.

1. 미리보기(아무것도 바꾸지 않음):
   ```
   npm run policy:restore -- <안전 정책 사본> <침해 전에 기록한 SHA-256> --service notes
   ```
   바뀔 항목(`- 허용 경로 빠짐`, `+ 허용 경로 되돌림`), 보존할 항목, 직접 확인할 규칙, 확인 코드(12자리)를 보여 줍니다.
2. 확인한 뒤 실행:
   ```
   npm run policy:restore -- <안전 정책 사본> <침해 전에 기록한 SHA-256> --service notes --apply <확인 코드>
   ```
   미리보기와 같은 상태일 때만(확인 코드가 같을 때만) 되돌립니다. 그 사이 설정이 바뀌었거나 다른 사본·서비스면 중단합니다.

- 사본이 없거나 검증(SHA-256 지문·형식)에 실패하면 미리보기 전에 중단합니다(10단계 제작 1과 같은 검증).
- **되돌리는 것**: `aleph.config.json`의 `allowedRoutes` 중 고른 서비스(`/api/<서비스>/…`)의 경로만.
- **보존하는 것**: 다른 서비스의 허용 경로와 순서, `aleph.config.json`의 다른 항목(`step`·`judgeIssuer` 등)과 항목 순서·줄바꿈, 판정기 규칙 코드(`src/decider.mjs`). 규칙은 코드라 자동으로 되돌리지 않고 `! 직접 확인`으로만 알려 줍니다.
- **감사 이력**: `audit/policy-restore.jsonl`에 실행마다 한 줄(시각·서비스·사본 지문·확인 코드·바뀐 경로)을 덧붙이기만 합니다. 기존 줄은 지우거나 고치지 않습니다. 바뀐 것이 없으면 쓰지 않습니다. 키·토큰·메모 내용은 남기지 않습니다.
- 운영 DB·Supabase·Vercel 설정은 건드리지 않고 네트워크도 쓰지 않습니다. 바뀐 `aleph.config.json`과 감사 이력은 학생이 검토해 커밋·배포해야 반영됩니다.

**다시 확인하는 방법**: `npm run test:stage10` (설정을 바꾸는 시험은 임시 폴더의 사본에서만 합니다)

## 추가: 10단계 제작 1 「안전 정책 사본과의 차이 보기」

**작동하는 기능**

- `npm run policy:diff -- <안전 정책 사본 경로> <침해 전에 기록한 SHA-256>`이 침해 전에 검증한 안전 정책 사본과 현재 시험 정책의 **차이만** 보여 줍니다. 같은 항목은 출력하지 않고, 차이가 없으면 `차이 없음`입니다.
  ```
  정책 차이(안전 사본 → 현재 시험 정책, 읽기 전용)
  ~ 단계: 8 → 9
  - 규칙 빠짐: old_rule
  + 허용 경로 추가: POST /api/notices
  ```
- 현재 시험 정책은 저장소에서 읽습니다: `src/decider.mjs`의 `RULE_IDS`, `aleph.config.json`의 `step`·`allowedRoutes`.
- 사본 형식은 `{ "schema": "aleph.policy.v1", "step", "ruleIds", "allowedRoutes" }`입니다.
- **사본이 없거나 검증에 실패하면 비교하지 않고 중단합니다**(종료 코드 1, 이유 한 줄). 검증은 사본 파일의 SHA-256이 침해 전에 따로 기록해 둔 지문과 같은지 보고, 형식도 확인합니다. 지문은 사본 안이 아니라 명령 인자로 받으므로, 사본을 바꾼 사람이 지문까지 다시 계산해 넣어도 통과하지 못합니다. 링크·폴더·너무 큰 파일도 중단합니다.
- 읽기 전용입니다. 운영 정책, `aleph.config.json`, 판정기, DB를 바꾸지 않고, 파일을 쓰지 않으며 네트워크도 쓰지 않습니다.

**아직 하지 않은 것**

- 안전 정책 사본과 그 지문은 저장소에 없습니다(만들지 않았음). 침해 전에 검증해 둔 사본과 지문으로만 비교합니다.
- (고침) 이후 제작 2·3에서 되돌리기와 메모 복원(`restoreRoute`)을 붙였고, `step`은 10으로 올렸습니다.

**다시 확인하는 방법**: `npm run test:stage10` (임시 폴더의 시험용 사본으로 시험하며 심판 판정이 아닙니다)

## 추가: 9단계 제작 3 「회수 제안」(고침: 계약 모양과 `burst_read`)

**작동하는 기능**

- 탐지 규칙이 복합 이상 패턴을 찾으면 별도의 탐지 결과(`src/detect.mjs`의 `detect`)로 회수를 제안합니다. 판정기의 허용/거부 응답(5항목)은 그대로입니다.
  ```
  { action: 'propose_revocation', reasonCode: 'burst_read', subject: '가명' }                     // 기기 칸이 없는 계약 사건
  { action: 'propose_revocation', reasonCode: 'burst_read', subject: '가명', deviceId: '16자리' }  // 확인된 기기 한 개
  ```
- 결과 모양과 이유 코드는 `docs/DETECT_EVENTS.md` 계약을 따릅니다. (고침) 처음에는 네트워크·기기 칸이 있어야만 제안하고 이유 코드도 등록되지 않은 `unusual_network_burst`를 써서, 계약 모양의 복합 의심 사건에 제안이 없었습니다.
- 복합 이상 패턴(탐지 사건): 같은 가명의 조회(GET)가 어느 10분 구간에서든 120건을 넘고, 그 구간의 네트워크가 모두 평소(`usual`)로 확인되지는 않은 경우입니다(다른 네트워크가 섞였거나 네트워크 정보가 없음). 평소 네트워크로 확인된 다량 조회, 정확히 120건, 10분 밖으로 흩어진 조회, 다른 사용자 합산은 제안하지 않습니다. 지역은 보지 않습니다.
- 대상 기기: 탐지 구간의 사건이 모두 같은 확인된 기기(16자리 `deviceId`)에서 왔으면 그 기기 하나를 `deviceId`로 덧붙입니다. 기기 칸이 없으면 기기를 지어내지 않고 가명으로만 제안하고, 기기가 둘 이상 섞이면 한 기기로 좁힐 수 없어 제안하지 않습니다.
- 복합 의심 사건(판정 요청 모양): 등록 기기에서 다른 네트워크(`judge_fixture`의 `unusual`)와 다량 조회(`recentEvents` 최근 300초 합계 10건 이상)가 함께 보이면 같은 모양으로 그 기기 하나를 제안합니다(`proposeRevocation(request)`, `detect([request])`).
- 의심 표시(`findSuspicious`, `unusual_network_burst`)는 제작 2 그대로입니다(다른 네트워크 + 다량 조회일 때만).
- 탐지는 제안만 돌려줍니다. 회수 API를 만들거나 부르지 않고, 기기 권한·세션·DB를 바꾸지 않으며, 로그도 남기지 않습니다. 자기 점검에는 `doppelganger_device_revocation`을 **미실행**으로 남깁니다. 실제 회수와 걸린 시간은 심판이 확인합니다.

**다시 확인하는 방법** (가상 사건 연습이며 실제 회수나 심판 판정이 아닙니다)

- `npm run detect:test` → 여섯 줄 모두 `통과`
- `npm run test:stage9`

## 추가: 9단계 제작 2 「의심 표시 규칙」(`unusual_network_burst`)

**작동하는 기능**

- `src/detect.mjs`의 `findSuspicious(events)`가 **평소와 다른 네트워크**와 **갑작스러운 다량 조회**가 함께 나타날 때만 의심으로 표시합니다. 결과는 `[{ subject, reasonCode: 'unusual_network_burst' }]`(가명과 이유 코드만)입니다.
- 기준: 같은 가명 사용자가 `network: 'unusual'`에서 보낸 조회(GET)가 어느 10분 구간에서든 120건을 넘을 때. 120건·10분은 `docs/DETECT_EVENTS.md`의 다량 조회 기준을 그대로 썼고, 정확히 120건은 표시하지 않습니다.
- 둘 중 하나만 보이면(평소 네트워크의 다량 조회, 다른 네트워크의 적은 조회) 표시하지 않습니다. 다른 사용자의 사건은 합치지 않습니다.
- **지역은 읽지 않습니다.** 그래서 지역 하나만으로 확정하는 일이 없습니다.
- 네트워크는 사건의 `signals.network`를 `signals.source`가 `judge_fixture`일 때만 읽습니다(판정 계약과 같은 모양). 출처가 없거나 불명확하거나 `unknown`이면 `null`로 두고 세지 않습니다. 사건 바깥의 `network`나 헤더는 읽지 않습니다.
- 정상 사건과 `detect` 결과는 그대로입니다(`detect`는 여전히 `{ action: 'observe' }`).

**아직 하지 않은 것**

- 의심 표시를 권한 회수 제안(`propose_revocation`)으로 이어 붙이지 않았습니다. 지금 연습 사건(`npm run detect:test`)에는 네트워크 칸이 없고, 계약은 다량 조회만으로 회수를 제안하라고 하므로 121건·200건 두 줄은 아직 「확인 필요」입니다.

**다시 확인하는 방법**: `npm run test:stage9` (가상 사건 연습이며 실제 회수나 심판 판정이 아닙니다)

## 추가: 9단계 시작 「step 9와 탐지 입력 정리」

**작동하는 기능**

- `aleph.config.json`의 `step`을 9로 올렸고, 빌드·배포 식별·자기 점검이 1~9단계를 받습니다(10단계 이상은 거부). 배포된 `/aleph.json`도 `"step": 9`입니다.
- `src/detect.mjs`의 `readDetectionEvents(events)`가 가상 사건(`docs/DETECT_EVENTS.md`)에서 아래 값만 읽고 나머지는 버립니다. 결과는 시각 순이고, 원본은 바꾸지 않습니다.

| 읽는 값 | 출처 | 없거나 틀리면 |
|---|---|---|
| 시각 `at` | `at` (UTC ISO) | 사건을 뺌 |
| 가명 사용자 `subject` | `identity.sub` (영문·숫자·`_.:-`) | 사건을 뺌(이메일·공백·한글처럼 실명·연락처로 보이는 값 포함) |
| 기기 `device` | `deviceId` (16자리 소문자 16진수) | `null` |
| 요청 종류 `method` | `method` (GET·POST·PUT·PATCH·DELETE) | `null` |
| 판정 `decision` | `decision` (allow·deny·step_up) | `null` |

- 메모 제목·본문, 토큰, 실명, 요청 본문·헤더, `identity`의 다른 값은 읽지도 저장하지도 출력하지도 않습니다. 탐지 파일은 로그를 남기지 않습니다.
- 지금 연습 사건에는 기기와 판정이 없어서 둘 다 `null`입니다. 정상값으로 채우지 않습니다.

**아직 하지 않은 것**

- 탐지 규칙(회수 제안)은 아직 없습니다. `detect`는 여전히 `{ action: 'observe' }`만 돌려주므로 `npm run detect:test`의 121건·200건 두 줄은 아직 「확인 필요」가 정상입니다.

**다시 확인하는 방법**: `npm run test:stage9` (가상 사건 시험이며 실제 접속 회수나 심판 판정이 아닙니다)

## 추가: 8단계 제작 3 「자료 API가 권한을 다시 대조합니다」

**작동하는 기능**

- `src/access-check.mjs`의 `checkAccess`가 검증된 사용자(`src/verify-login.mjs`의 userId)와 저장된 소유자·강사 권한을 대조합니다. 판정기가 허용한 요청도 이 확인을 다시 거칩니다.

| 자원 | 허용 조건 | 거부 사유 |
|---|---|---|
| 메모 `vault.note` | 저장된 `owner_id` = 검증된 사용자(강사 예외 없음) | `not_owner`, `owner_missing` |
| 반 공지 `class.notice` | 읽기: 로그인한 사용자 / 쓰기: 저장된 강사 권한 | `not_instructor` |
| 강사 자료 `instructor.material` | 저장된 강사 권한 | `not_instructor` |
| 그 밖 | 없음 | `unknown_resource` (검증된 사용자가 없으면 `no_verified_user`) |

- 메모 API는 DB가 `owner_id`로 거른 결과를 받은 뒤에도 각 행의 저장된 소유자를 한 번 더 대조합니다. 남의 행이 섞이면 목록에서 빼고, 한 건 조회는 404로 답합니다(있다는 사실도 알리지 않음). 삭제 결과가 남의 행이면 500으로 닫습니다.
- 거부하면 서버 로그에 짧은 사유만 남깁니다: `NOTES_ACCESS_DENIED {"method":"GET","route":"item","reason":"not_owner"}`. 사용자 ID·토큰·메모 본문은 남기지 않습니다. 없거나 남의 메모라 질의 결과가 비면 `not_found_or_not_owner`입니다.
- 강사 권한은 `readStoredRole`이 서버 전용 키로 Supabase Auth 사용자의 `app_metadata.class_role`(서버만 바꿀 수 있는 값)에서만 읽습니다. 화면 메뉴, 요청 본문·헤더·쿼리의 `role`, 사용자가 바꿀 수 있는 `user_metadata`는 믿지 않습니다.

**아직 하지 않은 것**

- 저장된 강사 권한을 실제로 넣지 않았습니다(어떤 계정에도 `class_role`이 없으므로 지금은 아무도 강사가 아님). 공지 API·관리 경로·강사 자료 API가 아직 없어서 `readStoredRole`은 그 경로들이 생길 때 씁니다.

**다시 확인하는 방법**: `npm run test:stage8` (가짜 저장소 시험이며 심판 판정이 아닙니다). 배포 뒤에는 B 계정으로 A의 메모 주소(`/api/notes/<A의 메모 id>`)를 요청하면 404이고, Vercel Logs에 `NOTES_ACCESS_DENIED … not_found_or_not_owner`가 남아야 합니다.

## 추가: 8단계 제작 2 「판정기의 구역 규칙」(규칙 `resource_zone`)

**작동하는 기능**

- `RULE_IDS = ['starter.deny', 'device_registered', 'step_up_required', 'resource_zone']`. 순서는 ① 기기(미등록 거부) → ② 구역 → ③ 복합 이상 추가 확인 → ④ 허용(`ruleIds: ['device_registered', 'resource_zone']`)입니다.
- 계약의 `service`·`method`·`path`·`route`만 보고 세 구역으로 나눕니다. `route`는 아래 모양과 글자 그대로 같아야 하고, `path`는 그 모양의 `:id` 자리에 한 칸을 넣은 것이어야 합니다. 계약 예시 모양(`/notes/:id`)과 `/api` 접두 모양(`/api/notes/:id`)을 모두 받습니다.

| 구역 | `service` | 허용 | 거부(이유 코드) |
|---|---|---|---|
| 메모 | `notes` | `GET`·`PUT`·`DELETE /notes/:id` | ID 없는 목록·추가(`/notes`), 다른 메서드, 더 깊은 경로 → `route_not_allowed` |
| 반 공지 | `notices` | `GET /notices`, `GET /notices/:id` | `POST`·`PUT`·`PATCH`·`DELETE`는 누구에게나 → `notice_read_only` |
| 강사 자료 | `materials` | 없음 | 모든 요청 → `instructor_materials_denied` |

- `service`와 `path`가 서로 다른 구역을 가리키면 더 엄격한 쪽을 먼저 적용하고(강사 자료 → 공지 쓰기), 그래도 다르면 거부합니다.
- 알 수 없는 경로·서비스, 쿼리가 붙은 요청(`queryLength`가 0이 아니거나 빈 쿼리 지문이 아님)은 `route_not_allowed`입니다. 쿼리로 기능을 고르지 않고, `:id`와 같은 깊이에 `export` 같은 기능 경로를 두지 않습니다(`/notes/export`는 "ID가 export인 메모"일 뿐).
- 메모 ID 형식은 좁히지 않습니다(심판의 가상 ID는 UUID가 아닐 수 있음). 빈 칸·`.`·`..`·인코딩된 `/`·`\\`처럼 한 칸이 아닌 것만 막습니다.
- 메모 주인 비교는 판정기가 하지 않고, 허용된 요청도 메모 API(제작 3, `src/notes-service.mjs`)가 로그인과 `owner_id`를 다시 확인합니다.
- `aleph.config.json`의 `allowedRoutes`는 판정기가 허용하는 다섯 경로만 남겼습니다: `GET /api/notes/:id`, `PUT /api/notes/:id`, `DELETE /api/notes/:id`, `GET /api/notices`, `GET /api/notices/:id`.

**아직 하지 않은 것**

- 판정 요청에 역할이 없어서 강사의 공지 수정은 판정기가 아니라 서버의 관리 경로에서 처리해야 합니다. 그 관리 경로와 공지 API·자료(`/api/notices`)는 아직 만들지 않았습니다.
- 화면이 쓰는 메모 목록·추가(`GET`·`POST /api/notes`)와 로그인 경로(`/api/auth/*`)는 판정기가 거부하는 경로라 허용 경로에서 뺐습니다. 이 경로들은 서버 함수로는 그대로 동작하지만, 엔진을 거치면 판정기가 거부합니다.
- 새 이유 코드(`route_not_allowed`, `notice_read_only`, `instructor_materials_denied`)는 운영 등록부에서 확인한 값이 아닙니다. 등록부에 없으면 엔진이 거부로 처리하므로, 거부 결과 자체는 바뀌지 않습니다.

**다시 확인하는 방법** (가상 요청 연습이며 심판 판정이 아닙니다): `npm run test:stage8`, `npm run decider:test`, `npm run fixture:7`

## 추가: 8단계 제작 1 「자료마다 자원 ID를 붙입니다」

**작동하는 기능**

- `src/resources.mjs`에 자원 ID 두 개를 정했습니다. 내 자료실 메모는 `vault.note`, 강사 공지는 `class.notice`입니다.
- 메모 API(`/api/notes`, `/api/notes/:id`)는 성공·거부(401·405·404·400·500)를 가리지 않고 **모든 응답에 `X-Resource-Id: vault.note`** 헤더를 붙입니다. 이 값은 서버 함수가 정하고, 브라우저가 보낸 `X-Resource-Id` 헤더·`?resource=` 쿼리·본문 값은 읽지 않습니다.
- `resourceOf(경로)`는 서버가 받은 경로로 자원을 구별합니다(`/api/notes…` → `vault.note`, `/api/notices…` → `class.notice`, 그 밖은 `null`).
- 기존 자료(Supabase `public.notes`), 주소, 허용 경로, 응답 본문, 화면 메뉴는 바꾸지 않았습니다.

**아직 하지 않은 것**

- 강사 공지는 아직 서버 함수와 자료가 없습니다. ID와 예정 경로(`/api/notices`)만 정했고, 공지 API·자료·화면 메뉴와 자원별 접근 규칙은 이후 요청에서 다룹니다.

**다시 확인하는 방법**: `npm run test:stage8`. 배포 뒤에는 F12 → Network에서 `/api/notes` 요청을 눌러 응답 헤더에 `X-Resource-Id: vault.note`가 있는지 봅니다.

## 추가: 7단계 제작 3 「다시 로그인 확인」 계약 점검 결과

**계약 확인 결과: 아직 없음**

- 판정 요청(`docs/DECIDER_REQUEST.md`)에는 `stepUp: {verified, authAgeSeconds}`만 있습니다. 이 값이 **같은 내 로그인**(같은 주체·세션)의 다시 로그인이라는 내용, 엔진의 다시 로그인 흐름, 앱 서버 함수와의 연결 계약은 저장소에 없습니다(문서가 가리키는 `student-kit/sdp-core/decision-contract.mjs`도 저장소에 없음). 지금 실제 경로는 `signals.source: 'none'`이라 복합 이상 규칙이 켜지지도 않습니다.
- 그래서 앱 쪽에 따로 재로그인 검사를 만들지 않았고, 판정기 코드도 바꾸지 않았습니다.

**한 것**

- 가상 사건 시험만 더했습니다(`npm run test:stage7`): 다시 로그인 전에는 읽기·쓰기 모두 `step_up`, 새 로그인 뒤(`stepUp.verified: true`, 0~900초) 새 요청은 다시 판정해 `allow`, 확인 안 됐거나 900초를 넘으면 계속 `step_up`.
- 자기 점검(`npm run bundle`)에 `step_up_reauth_notes_read`를 **미실행**으로 남깁니다. 실제 자료 차단과 재판정은 계약이 준비된 환경에서만 실측합니다.
- 토큰 원문은 만들거나 기록하지 않습니다(판정기는 로그를 남기지 않고, 시험이 자기 점검 결과에 토큰 모양이 없는지 확인).

## 고침: `step` 8과 빌드 단계 범위

- `aleph.config.json`의 `step`을 8로 올렸습니다. 배포된 `/aleph.json`도 `"step": 8`로 보입니다.
- 앞서 `step`만 7로 바꿨을 때 빌드(`scripts/build-public.mjs`)·배포 식별(`scripts/deployment-identity.mjs`)·자기 점검(`src/attack-check.mjs`)이 1~6단계만 받아 빌드가 멈췄습니다. 세 곳 모두 1~8단계를 받도록 넓혔습니다. 9단계 이상은 계속 거부합니다.
- 자기 점검이 실제로 보내는 요청은 그대로 6건이고, 미등록 기기·다시 로그인 점검은 미실행으로 남습니다.

## 추가: 7단계 제작 2 「평소와 다른 접속은 다시 확인합니다」(규칙 `step_up_required`)

**작동하는 기능**

- `RULE_IDS = ['starter.deny', 'device_registered', 'step_up_required']`. 기존 기기 규칙이 먼저이고(미등록 → `deny`·`device_not_registered`, 화면 밖 메서드 → 기본 거부), 기기 규칙이 허용할 요청에만 이 규칙을 봅니다.
- 아래 세 조건이 **모두** 보이면 `step_up`(추가 본인 확인)이고, 사유는 응답의 `reasonCode: 'step_up_required'`, `ruleIds: ['step_up_required']`로 남습니다.

| 조건 | 기준(연습용 고정값) |
|---|---|
| 평소와 다른 시각 | `signals.hour`가 0~5시 |
| 처음 보는 네트워크 | `signals.network`가 `unusual` |
| 갑작스러운 대량 읽기 | `recentEvents` 중 최근 300초 안의 `count` 합이 10 이상 |

- 하나나 둘만 보이면 허용합니다. **지역(`region`)은 조건에 넣지 않아** 지역 하나만으로는 거부도 추가 확인도 하지 않으며, 이 규칙에는 영구 차단(`deny`)이 없습니다.
- 값이 없거나 출처가 불명확하면(`source: 'none'`·`unclear`, `unknown`, 형식 오류) 이상으로도 정상으로도 세지 않아 이 규칙이 켜지지 않습니다.
- 추가 확인을 마친 경우(`stepUp.verified: true`, `authAgeSeconds` 0~900초)만 같은 복합 이상을 다시 묻지 않습니다.

**아직 하지 않은 것**

- "평소"를 사용자별 이력으로 판단하지 않고 고정 기준값을 씁니다(이력은 계약에 없음). 실제 경로는 지금 `source: 'none'`이라 이 규칙이 켜지지 않고, 심판의 가상 사건에서만 켜집니다.
- `step_up_required` 이유 코드는 연습 도구(`decider:test`)의 기대값을 근거로 골랐고, 운영 등록부에서 확인한 값은 아닙니다.

**다시 확인하는 방법** (모두 가상 요청 연습이며 심판 판정이 아닙니다)

- `npm run fixture:7` → `정상 사건: allow`, `복합 이상 사건: step_up`
- `npm run decider:test` → 네 줄 모두 `통과`
- `npm run decider:show` → 복합 이상 접속 `step_up · step_up_required · step_up_required`, 다시 확인한 복합 이상 접속 `allow`
- `npm run test:stage7`

## 추가: 6단계 제작 「등록한 기기만 자료실에 들어옵니다」

**작동하는 기능**

- `src/decider.mjs`에 규칙 `device_registered`를 더했습니다(`RULE_IDS = ['starter.deny', 'device_registered']`). 판정 요청은 반 엔진이 신원·기기·경로를 확인한 뒤 넘기는 값이고, 이 규칙은 계약(`docs/DECIDER_REQUEST.md`)의 `request.deviceRegistered`만 봅니다.
- `deviceRegistered`가 `true`이고 기존 화면이 쓰는 메서드(GET·POST·PUT·DELETE: 화면 열기, 로그인·로그아웃, 메모 읽기·추가·수정·삭제)면 `allow`(`reasonCode: 'approved'`, `ruleIds: ['device_registered']`)입니다. 이 판정 뒤에도 서버 함수의 로그인 검사와 소유자 검사는 그대로 거칩니다. (처음에는 읽기만 허용해서 등록 기기에서도 로그인과 메모 저장이 막혔기 때문에 고쳤습니다.)
- 값이 `false`이거나 없거나 `true`가 아니면(문자열 `"true"`, `1` 등) 어떤 요청이든 `deny`(`reasonCode: 'device_not_registered'`)입니다.
- 화면이 쓰지 않는 메서드(PATCH·HEAD·OPTIONS 등)는 이 규칙이 허용하지 않고, 시작 틀의 기본 거부(`starter.deny`, `starter_not_ready`)가 그대로 답합니다.
- 응답은 계약의 다섯 항목만 담고, 계약에 없는 `request.device`·`identity`·`role`·`geo`는 쓰지 않습니다. 앱의 서버 함수와 화면은 바꾸지 않았습니다.

**아직 하지 않은 것**

- `reasonCode`는 운영 등록부에 있어야 합니다. `approved`(계약 예시)와 `device_not_registered`(연습 도구)는 저장소 안의 근거로 고른 값이고, 운영 등록부에서 확인한 값은 아닙니다.
- (고침) `aleph.config.json`의 `step`을 6으로 올렸습니다. 처음에는 5로 남아 있어서 배포된 `/aleph.json`이 5단계로 보였습니다. 빌드·배포 식별·자기 점검이 6단계를 받도록 함께 넓혔고, 자기 점검에는 미등록 기기 점검(`unregistered_device_notes_read`)을 `미실행`으로 더했습니다(미등록 기기 공격은 심판이 보냄).
- `npm run fixture:7`(7단계 추가 본인 확인 연습)은 아직 실패하는 것이 정상입니다.

**판정기 확인 순서**

따로 설치할 접속 프로그램은 없습니다. 저장소 폴더에서 `npm install`(또는 `npm ci`)로 의존성만 설치된 상태면 됩니다. 아래는 가상 요청으로 하는 연습이고 심판 판정이 아닙니다. 실제 미등록 기기 공격은 심판이 보냅니다.

1. `npm run decider:test`를 실행합니다. 다음 두 줄이 나오면 연습 확인을 통과한 것입니다.
   ```
   통과 · 등록 기기의 정상 요청
   통과 · 미등록 기기의 가상 요청
   ```
   두 번째 줄은 판정이 `deny`이고 이유 코드가 `device_not_registered`일 때만 「통과」입니다. 「확인 필요」가 나오면 그 줄의 규칙을 고칩니다.
2. `npm run decider:show`를 실행해 같은 가상 요청의 실제 판정 값을 봅니다.
   ```
   등록 기기의 정상 요청 (deviceRegistered: true, GET) → allow · approved · device_registered
   미등록 기기의 가상 요청 (deviceRegistered: false, GET) → deny · device_not_registered · device_registered
   ```
3. `npm run test:stage6`을 실행해 값이 없거나 `true`가 아닌 경우, 기존 화면이 쓰는 모든 요청(등록 기기 허용·미등록 기기 거부), 응답 형식까지 시험합니다.

## 추가: 5단계 개선 「키는 서버 함수에만, 허용 경로는 배포 파일에」

**작동하는 기능**

- **화면 코드에 Supabase 키·주소가 없습니다.** 로그인·로그아웃은 서버 함수가 서버 전용 설정(`SUPABASE_URL`, `SUPABASE_SECRET_KEY`)으로 Supabase Auth를 불러 처리합니다. 새 환경변수는 없습니다.

| 요청 | 하는 일 | 응답 |
|---|---|---|
| `POST /api/auth/login` `{email, password}` | 로그인 | 200 `{email}` + 세션 쿠키. 실패하면 `{error, code, message}`(예: 401 `invalid_credentials`) |
| `GET /api/auth/session` | 로그인 상태 확인(만료됐으면 갱신) | 200 `{email}` 또는 401 |
| `POST /api/auth/logout` | 이 세션을 끊고 쿠키 삭제 | 204 |

- 로그인 토큰은 **HttpOnly·Secure·SameSite=Strict 쿠키**(`aleph_at`, `aleph_rt`)로만 브라우저에 있습니다. 화면 스크립트는 토큰을 읽거나 저장하지 않고, 응답 본문과 로그에도 토큰·이메일·비밀번호가 나가지 않습니다. 브라우저 저장소에 세션을 두던 예전 약점도 함께 없어졌습니다.
- 로그인 요청은 JSON이어야 하고, 다른 사이트(`Origin`이 다른 곳)에서 온 로그인·로그아웃 요청은 403으로 막습니다.
- 메모 API는 `Authorization` 헤더가 있으면 그것만 검사하고(심판의 로그인), 없을 때만 쿠키의 토큰을 **같은 검사기**(`src/verify-login.mjs`)로 검사합니다. 소유자 검사는 그대로입니다. 「로그인 없이 목록 요청해 보기」 버튼은 쿠키를 빼고(`credentials: 'omit'`) 보냅니다.
- 빌드는 브라우저용 Supabase SDK를 더 이상 내려주지 않습니다(`public/vendor/` 없음).
- **배포 파일 `/aleph.json`에 `allowedRoutes`**가 실립니다(3단계부터, `메서드 경로` 모양 1~20개, 형식이 틀리면 빌드 중단). 로그인 경로 세 줄을 더해 지금 허용 경로는 여덟 줄입니다.
- 첫 화면 보안 헤더(`X-Content-Type-Options: nosniff`)는 `vercel.json`에 이미 있어 그대로입니다.

**아직 하지 않은 것**

- 로그인 요청이 모두 Vercel 서버에서 Supabase로 가므로, Supabase의 IP별 로그인 횟수 제한에 여러 사용자가 함께 걸릴 수 있습니다(학습용 규모에서는 문제가 적음).
- 세션 쿠키는 `Secure`라 https(배포 주소)나 `localhost`에서만 동작합니다.
- 실제 Vercel 배포와 실제 Supabase 계정으로는 이 저장소에서 확인하지 못했습니다(가짜 Supabase 응답과 가상 브라우저로 확인).

**다시 실행하고 확인하는 방법**

- 로컬 시험: `npm run test:auth`, `npm run test:login`, `npm run test:stage5`
- 배포 뒤 정상: a@example.com으로 로그인하면 메모 추가·수정·삭제가 되고, 새로고침해도 로그인이 유지됩니다. `/aleph.json`에 `allowedRoutes`와 `originalApiUrl`이 보입니다.
- 배포 뒤 확인: 첫 화면에서 F12 → Sources(또는 페이지 소스 보기)로 `sb_publishable_`와 `supabase.co`를 찾으면 없어야 합니다. F12 → Application → Cookies에서 `aleph_at`의 HttpOnly가 체크되어 있어야 합니다.

## 5단계 저장점: 현재 작동하는 기능과 다시 실행하는 방법

**지금 되는 것**

- 이메일·비밀번호 로그인·로그아웃 화면. (5단계 개선 뒤) 로그인도 서버 함수(`/api/auth/*`)가 하고 화면 코드는 Supabase를 부르지 않습니다. 메모 자료는 서버 함수(`/api/notes`, `/api/notes/:id`)로만 읽고 씁니다.
- 서버 함수는 모든 요청의 로그인 토큰을 시작 틀의 `src/verify-login.mjs`로 검사하고(없거나 틀리면 401 `{error, message}`), 확인된 사용자 ID와 `owner_id`가 같은 메모만 다룹니다(남의 메모는 404). DB는 서버 전용 키로만 접근합니다.
- 공개 `data.json`은 없고 자료는 Supabase `public.notes`에 있습니다.

**`aleph.config.json` 대조**

| 항목 | 값 | 구현과 맞는지 |
|---|---|---|
| `step` | 5 | 자료 요청을 서버 함수 한곳으로 모았습니다. 빌드·배포 식별·자기 점검이 5단계를 받도록 함께 넓혔습니다. |
| `repoUrl` | `https://github.com/lley01/choi-bujang-secret-vault-2` | Git `origin`과 같습니다. |
| `publicAppUrl` | `…-git-main-lley01.vercel.app/` | 알려 준 배포 주소입니다. 실제 배포에서 열어 확인한 값이 아닙니다. |
| `identityProvider` | `issuer`·`audience`·`jwksUrl` (공개 값) | 화면이 쓰는 Supabase 프로젝트와 같습니다(시험으로 확인). |
| `allowedRoutes` | 메모 다섯 경로 + (5단계 개선) `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout` | 서버 함수가 처리하는 메서드·경로와 같고, 배포 파일 `/aleph.json`에도 실립니다(시험으로 확인). |
| `originalApiUrl` | `https://iaifwhhyhzyacfdwziuo.supabase.co/rest/v1/notes` | 쿼리 없는 원본 자료 HTTPS 경로, 즉 학습 DB(Supabase)의 메모 자료 API입니다. 공개 키·시험 계정 토큰으로 직접 부르면 `403 42501`로 막힙니다(5단계 고침, 브라우저에서 확인). |
| `judgeIssuer` | 운영 측이 채운 값 | 바꾸지 않았습니다. |

- 심판은 배포된 사이트의 `/aleph.json`에서 `originalApiUrl`을 읽습니다. 배포 빌드(`scripts/deployment-identity.mjs`)가 5단계부터 이 값을 `/aleph.json`에 함께 싣습니다. https가 아니거나 쿼리·계정 정보가 붙어 있으면 빌드를 멈춥니다(판정 `S05_ORIGINAL_URL_MISSING` 고침).

**DB 직접 권한**

- 메모 테이블의 PUBLIC·anon·authenticated 직접 권한을 거두는 SQL은 저장소 밖에서 제안했습니다. 실행했는지는 이 저장소로 확인할 수 없으니 그 SQL의 ①·③ 확인 쿼리로 보세요.

**다시 실행하고 확인하는 방법**

- 키·네트워크 없이 하는 로컬 시험: `npm run test:stage5`, `test:stage4`, `test:stage3`, `test:notes-api`, `test:login-api`, `test:login`, `test:step2`
- 제출 묶음: 배포가 끝난 뒤 학생 컴퓨터에서 `npm run bundle`. 먼저 `bundle-notes.json`(커밋하지 않음)에 이번 단계에서 한 일을 적고, 변경을 커밋해 작업 폴더를 깨끗하게 둡니다. 이 점검은 `publicAppUrl`로 실제 요청을 보냅니다.
- 자기 점검(`src/attack-check.mjs`)은 심판의 판정이 아닙니다. 로그인 없는 요청 6건을 실제로 보내고, **우리 앱의 401 JSON(`LOGIN_REQUIRED`)일 때만 "거부됨"**으로 적습니다. 네트워크 프록시나 배포 보호 화면이 막은 401·403은 "판정 불가"로 적습니다. 토큰이 필요한 정상 로그인, B가 A의 메모에 접근, 학습 DB REST 직접 접근 점검은 `미실행`으로 남깁니다.

**아직 하지 않은 것**

- 추가할 때 이미 있는 `id`면 409라서, 그 id가 쓰였다는 사실은 알 수 있습니다(내용은 알 수 없음). 호출 한도는 없습니다.
- `api/ai.js`·`api/threat-intel.js`는 501 뼈대 그대로이고, `RULE_IDS`는 시작 틀의 `starter.deny`만 있습니다.

## 추가: 5단계 제작 「자료 요청을 서버 한곳으로 모읍니다」

**작동하는 기능**

- 브라우저 코드(`public/index.html`)는 메모 자료를 Supabase에서 직접 읽거나 고치지 않습니다. Supabase 클라이언트는 로그인(`auth`)에만 쓰고, 메모는 서버 함수(`/api/notes`, `/api/notes/:id`)만 부릅니다(`test/stage5.test.mjs`로 고정).
- 서버 함수의 로그인 검사·소유자 검사와 서버 전용 설정(`SUPABASE_URL`, `SUPABASE_SECRET_KEY`)은 그대로입니다.
- `aleph.config.json`의 `originalApiUrl`은 쿼리 없는 원본 자료 HTTPS 경로 `https://iaifwhhyhzyacfdwziuo.supabase.co/rest/v1/notes`입니다. (고침) 처음에는 우리 서버 함수 주소(`…vercel.app/api/notes`)를 적었는데, 서버 함수는 로그인한 시험 계정에 자료를 주는 것이 정상이라 '원본 직접 조회'가 성공한 것처럼 보였습니다. 원본은 서버 함수가 자료를 가져오는 Supabase 자료 API입니다.

**DB 직접 권한**

- 메모 테이블(`public.notes`)의 PUBLIC·anon·authenticated 직접 권한을 거두는 SQL을 저장소 밖에서 제안했습니다. 실행하면 로그인 토큰이나 publishable key로 Supabase REST를 직접 부르는 길이 닫히고, 메모는 서버 함수를 거쳐서만 다룹니다. RLS·4단계 정책·`service_role` 권한·다른 테이블은 그대로 둡니다. 실행했는지는 이 저장소로 확인할 수 없으니 SQL의 ①·③ 확인 쿼리로 보세요.

**아직 하지 않은 것**

- (제작 시점의 기록) 이때는 `step`이 4였습니다. 5단계 저장점에서 5로 올렸습니다. `scripts/bundle.mjs`는 5단계부터 `originalApiUrl`에 https 주소를 요구합니다.
- `publicAppUrl`은 실제 배포에서 열어 확인한 값이 아닙니다. `originalApiUrl`(Supabase 자료 API)은 공개 키·시험 계정 토큰 직접 조회가 `403 42501`로 막히는 것을 브라우저에서 확인했습니다.
- (해소됨) `src/attack-check.mjs`가 401·403이면 누가 답했든 "거부됨"으로 적던 문제는 5단계 저장점에서 고쳤습니다. 지금은 우리 앱의 401 JSON일 때만 거부로 적습니다.

**다시 실행하고 확인하는 방법**

- 로컬 시험: `npm run test:stage5`
- 배포 뒤 정상: a@example.com으로 로그인해 메모를 추가·수정·삭제할 수 있습니다.
- 배포 뒤 거부되어야 할 결과(권한 SQL 실행 뒤): 로그인한 화면의 F12 → Console에서 Supabase REST를 직접 부르면 거부됩니다(예: `window.supabase.createClient(...)`로 만든 클라이언트의 `from('notes').select()` 결과가 permission denied 오류).

## 4단계 저장점 시점의 기록

(아래 표와 목록은 4단계 저장점 때의 값입니다. 지금 값은 맨 위 「5단계 저장점」을 보세요.)

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
| `originalApiUrl` | `null`(4단계 저장점 당시) | 5단계에서 채웠습니다. 지금 값은 맨 위 「5단계 저장점」을 보세요. |

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

- (제작 시점의 기록) 이때는 DB 권한(RLS 정책)을 바꾸지 않았습니다. 그 뒤 DB 정책 SQL과 5단계의 직접 권한 회수 SQL을 저장소 밖에서 제안했습니다.
- 추가할 때 이미 있는 `id`를 보내면 409(`ID_EXISTS`)라서, 그 id가 이미 쓰였다는 사실은 알 수 있습니다(내용은 알 수 없음).
- (제작 시점의 기록) 이때는 `src/attack-check.mjs`에 "B가 A의 메모를 읽을 수 있는가" 점검이 없었습니다. 4단계 저장점에서 `미실행` 항목(`other_owner_note_access`)으로 넣었습니다(두 사용자 토큰이 필요).
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
