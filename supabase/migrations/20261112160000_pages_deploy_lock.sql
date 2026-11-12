-- 공개 이미지 Pages 프로젝트 배포 뮤텍스(2026-11-12).
--
-- 배경(세 번째 재발): 사용설명서 발행은 이미지를 공개 Cloudflare Pages로 복사하는데, Pages 배포는
-- **사이트 전체 스냅샷**이라 두 발행이 겹치면 나중 배포가 자기가 읽은 옛 목록으로 스냅샷을 만들어
-- 앞 글 파일을 지운다(발행본 이미지가 전부 404). 2026-10-15·10-31에 두 번 고쳤는데 두 번 다 막은
-- 것이 Cloudflare **배포 목록 API**였다 - "진행 중인 배포가 없을 때까지 기다린다", "배포가 다 빠진
-- 뒤에 검증한다".
--
-- 2026-11-12에 세 편이 15초·13초 간격으로 발행되며 또 터졌고, Cloudflare API 실측으로 그 두 겹이
-- 애초에 틈을 못 막는다는 것이 드러났다: 배포는 **1.3~1.8초**만 걸리는데(02:22:59.9→02:23:01.5,
-- 02:23:15.2→02:23:16.5, 02:23:23.8→02:23:25.6) 정작 다투는 구간은 **목록 읽기 → 기존 전량
-- 내려받기 → 배포 생성**의 15~25초이고, 이 구간은 배포 목록에 아무 흔적이 없다. 세 run 모두 락과
-- 드레인을 즉시 통과했고(대기 로그 0줄) 가운데 글만 7장 전부 404가 됐다.
--
-- 그래서 락을 Cloudflare 밖, 러너가 모두 공유하는 여기에 둔다. 설계는 pipeline_lock과 같다 -
-- 조건부 UPDATE 하나가 Postgres 행 잠금으로 원자적이라(SQL compare-and-swap) 여러 러너가 같은
-- 순간에 시도해도 정확히 하나만 성공한다. pipeline_lock을 재사용하지 않는 이유: 그쪽은 조사·집필
-- (15~25분)이 쥐고 있어 발행 버튼이 그만큼 멈춘다.
--
-- 주의: 이 migration은 파일 작성 후 사용자 승인을 받아 `supabase db push`로 적용한다.
-- 적용 전에도 코드는 깨지지 않는다 - 테이블이 없으면(42P01·PGRST205) 락 없이 진행하고
-- rehostImagesToPages의 두 그물(배포 직전 목록 재확인 · 검증 통과 뒤 지켜보기)이 받는다.

create table if not exists public.pages_deploy_lock (
  -- Cloudflare Pages 프로젝트 이름(KSCENE_IMAGES_PAGES_PROJECT). 프로젝트가 다르면 다투지 않으므로
  -- 프로젝트마다 한 행이고, 그래서 singleton이 아니라 PK가 project다.
  project text primary key,

  -- 누가 쥐고 있는지(감사용). "run-<GITHUB_RUN_ID>:<jobId>" 또는 "local:<jobId>".
  holder text,

  locked_at timestamptz,

  -- 리스 만료 시각. 러너가 비정상 종료돼 release를 못 불러도 이 시각이 지나면 다음 발행이 가져간다
  -- (LEASE_MS, 코드 상수 8분 - 발행 한 건은 1~2분이다). 획득은
  -- `update ... where project = ? and expires_at <= now()` 한 문장이고, 해제는 expires_at을 지금으로
  -- 당기는 것이다(행을 지우지 않으므로 마지막 holder가 남아 있다).
  expires_at timestamptz not null default now()
);

comment on table public.pages_deploy_lock is
  '공개 이미지 Pages 프로젝트 배포 뮤텍스(프로젝트당 1행). Pages 배포가 사이트 전체 스냅샷이라
   스냅샷을 만드는 구간(목록 읽기~배포 생성, 15~25초)이 겹치면 앞 글 이미지가 지워진다 -
   그 구간은 Cloudflare 배포 목록 API에 보이지 않아 러너 밖의 락이 필요하다(2026-11-12).';

-- ---------- 권한 ----------
-- article_jobs/pipeline_lock과 동일 정책 - service_role만 접근, anon/authenticated는 차단.

alter table public.pages_deploy_lock enable row level security;
revoke all on table public.pages_deploy_lock from anon, authenticated;
grant select, insert, update on table public.pages_deploy_lock to service_role;
