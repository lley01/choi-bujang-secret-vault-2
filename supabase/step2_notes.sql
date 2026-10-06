-- 2단계: 가상 메모를 코드 밖(Supabase 테이블)으로 옮기는 학습용 SQL입니다.
-- 실행 위치: Supabase 대시보드의 SQL Editor (학생 본인의 학습용 프로젝트).
-- 이 파일에는 키·비밀번호·토큰이 없습니다. 아래 메모 네 건은 모두 실습용 가상 자료입니다.
-- 실제 학생 자료는 이 파일이나 Git에 넣지 마세요.

-- 1) 테이블
-- owner_id는 나중 단계(로그인)에서 쓰려고 칸만 둡니다.
-- auth.users 외래키는 일부러 걸지 않으며, 지금은 비어 있어도(null) 됩니다.
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid,
  title      text not null,
  content    text not null,
  created_at timestamptz not null default now()
);

-- 2) RLS 켜기
-- 정책(policy)은 하나도 만들지 않습니다. 정책이 없으면 RLS가 켜진 테이블은 기본 거부입니다.
alter table public.notes enable row level security;

-- 3) 공개 역할의 권한 회수
-- Supabase는 public 스키마의 새 테이블에 anon·authenticated 권한을 기본으로 줄 수 있어서,
-- RLS와 별개로 테이블 권한 자체를 명시적으로 회수합니다.
revoke all on table public.notes from anon, authenticated;

-- 서버 전용 역할만 접근합니다. (service_role 키는 서버 환경변수에만 두고, 이 파일에는 쓰지 않습니다.)
grant select, insert, update, delete on table public.notes to service_role;

-- 4) 가상 메모 시드 (다시 실행해도 같은 제목이 중복으로 들어가지 않습니다)
insert into public.notes (title, content)
select v.title, v.content
from (values
  ('과제',           '실습용 가상 과제 기록'),
  ('포트폴리오',     '실습용 가상 포트폴리오 기록'),
  ('아침 리추얼',    '실습용 가상 리추얼 기록'),
  ('훈련 행정 자료', '실습용 가상 행정 기록')
) as v(title, content)
where not exists (
  select 1 from public.notes n
  where n.title = v.title and n.owner_id is null
);

-- 5) 실행 뒤 확인용 (SQL Editor에서 직접 실행)
-- 정상: 아래 두 줄이 true / 권한 목록에 anon·authenticated가 없음
--   select relrowsecurity from pg_class where oid = 'public.notes'::regclass;
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'notes';
-- 거부되어야 할 결과: anon 키로 /rest/v1/notes 를 요청하면 401/403 또는 권한 오류
