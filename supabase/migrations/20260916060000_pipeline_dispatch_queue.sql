-- 조사/집필/재작성(heavy-pipeline: job-research.yml/job-write.yml/job-revise.yml)의 실행 순서를
-- GitHub Actions concurrency 큐가 아니라 여기서 직접 관리한다.
--
-- 배경(2026-09-15/16 실측 사고, 연속 이틀): heavy-pipeline은 GitHub Actions concurrency group
-- 하나로 직렬화돼 있는데, 이 큐는 "실행 중 1개 + 대기 1개"까지만 허용하고 그 이상 들어오면
-- 대기 중이던 실행을 경고 없이 취소한다. 09-15 저녁에 대기 후 그냥 디스패치하는 완화책을
-- 넣었지만(dispatchWorkflow.ts의 concurrencyGroupWorkflows 대기), 대기 상한(3~5분)이 실제
-- 소요 시간(15~25분)보다 훨씬 짧아 사용자가 같은 목록에서 Go를 30~90초 간격으로 몇 번만 눌러도
-- 대기 상한을 넘겨 그대로 취소를 유발했다 - 09-16 오후에도 선택 7건 중 4건이 이 경로로
-- 유실됐다(조사조차 시작 못 한 채 status=selected에 멈춤).
--
-- 이 테이블들은 GitHub 큐에 전혀 의존하지 않는다: 디스패치 직전에 여기서 원자적으로 "지금 뭔가
-- 돌고 있는지"를 확인하고, 돌고 있으면 큐에 쌓아두기만 한다. 실행 중이던 워크플로우가 끝나면
-- (job-research.yml/job-write.yml/job-revise.yml 마지막 스텝, if: always())
-- markDoneAndDrain()을 호출해 락을 풀고 곧바로 다음 대기 항목을 스스로 깨운다 - 대기 인원이
-- 몇 명이든 GitHub 큐의 "대기 1개" 한도에 안 걸리고 순서대로 전부 처리된다.
--
-- 주의: 이 migration은 파일 작성 후 사용자 승인을 받아 `supabase db push`로 적용한다.

create table if not exists public.pipeline_dispatch_queue (
  id bigint generated always as identity primary key,

  -- article_jobs.id. FK로 참조하지 않는다(manuscript_manifest_topics.sql과 같은 이유 - job이
  -- 나중에 정리돼도 이 큐 행은 감사 로그로 독립적으로 남아 있어도 무방하다).
  job_id uuid not null,

  -- "job-research.yml" | "job-write.yml" | "job-revise.yml".
  workflow_file text not null,

  -- workflow_dispatch에 그대로 넘길 추가 입력(job_id는 자동으로 합쳐지므로 여기엔 나머지만,
  -- 예: job-revise의 feedback). 빈 경우가 많아 기본값을 둔다.
  inputs jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (status in ('pending', 'dispatched', 'done', 'failed')),

  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  -- 디스패치 자체(GitHub API 호출)가 실패했거나 워크플로우가 failure로 끝났을 때의 사유.
  error text
);

create index if not exists idx_pipeline_dispatch_queue_pending
  on public.pipeline_dispatch_queue (created_at asc)
  where status = 'pending';

comment on table public.pipeline_dispatch_queue is
  'heavy-pipeline(조사/집필/재작성) 디스패치 대기열. GitHub Actions concurrency 큐(대기 1개
   한도)에 의존하지 않고 여기서 순서를 직접 관리한다 - pipeline_lock과 함께 쓴다.';

-- 싱글턴 뮤텍스. is_busy를 false -> true로 바꾸는 UPDATE ... WHERE id = 1 AND is_busy = false는
-- Postgres 행 잠금으로 원자적이라, 여러 프로세스가 동시에 시도해도 정확히 하나만 성공한다
-- (SQL 레벨 compare-and-swap - 별도 advisory lock이 필요 없다).
create table if not exists public.pipeline_lock (
  id smallint primary key default 1 check (id = 1),
  is_busy boolean not null default false,
  current_queue_id bigint references public.pipeline_dispatch_queue (id) on delete set null,
  locked_at timestamptz
);

comment on table public.pipeline_lock is
  '싱글턴 뮤텍스(정확히 1행). is_busy=true인 채로 locked_at이 30분(STALE_LOCK_MS, 코드 상수)을
   넘기면 러너가 비정상 종료된 것으로 보고 다음 요청이 자동으로 회수한다 - 영구 정지 방지.';

insert into public.pipeline_lock (id, is_busy)
values (1, false)
on conflict (id) do nothing;

-- ---------- 권한 ----------
-- article_jobs/manuscript_manifest_topics와 동일 정책 - service_role만 접근, anon/authenticated는 차단.

alter table public.pipeline_dispatch_queue enable row level security;
revoke all on table public.pipeline_dispatch_queue from anon, authenticated;
grant select, insert, update, delete on table public.pipeline_dispatch_queue to service_role;
grant usage, select on sequence public.pipeline_dispatch_queue_id_seq to service_role;

alter table public.pipeline_lock enable row level security;
revoke all on table public.pipeline_lock from anon, authenticated;
grant select, insert, update on table public.pipeline_lock to service_role;
