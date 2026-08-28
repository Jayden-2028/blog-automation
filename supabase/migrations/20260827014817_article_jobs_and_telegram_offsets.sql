-- Sprint 1: 선택 루프(Telegram 인라인 버튼 -> 원고 job) 지원 테이블 2개.
-- 설계 근거는 docs/ai-handoff/SPRINT_1_DESIGN.md 참고.
--
-- 주의: 이 migration은 파일만 작성한 것이며, 실제 Supabase 프로젝트 적용은 사용자 승인 후에 한다.
-- 적용 전까지 ArticleJobRepository / TelegramOffsetRepository 호출은 실패한다.

create extension if not exists pgcrypto;

-- ---------- article_jobs ----------
-- 사용자가 Telegram에서 선택한 키워드 1건 = job 1건. 이후 모든 단계(조사 -> 집필 -> 이미지 ->
-- 검수 -> 발행)의 상태 머신이 된다.
--
-- keyword_rankings를 FK로 참조하지 않고 값을 복사하는 이유:
-- keyword_rankings는 discovery_run 단위 "스냅샷"이고 run이 쌓이면 정리 대상이 된다. 반면 job은
-- 선택 시점부터 발행까지 며칠~몇 주 살아 있어야 하므로, 참조가 끊겨도 job 혼자서 원고를 만들 수
-- 있어야 한다. keyword_rankings가 keywords를 참조하지 않고 랭킹 당시 값을 그대로 저장해둔 것과
-- 같은 이유다.

create table if not exists public.article_jobs (
  id uuid primary key default gen_random_uuid(),

  -- 출처 스냅샷(선택 시점의 keyword_rankings 값 복사).
  source_run_id integer not null,
  source_rank integer not null,
  keyword text not null,
  headline text,
  seed_query text,
  category text,
  total_score integer,
  score_breakdown jsonb,

  status text not null default 'selected',
  selected_at timestamptz not null default now(),
  -- 어떤 경로로 선택됐는지. 지금은 telegram만 있지만 나중에 대시보드/수동 등록이 생길 수 있다.
  selected_via text not null default 'telegram',

  -- 생성된 추천 제목(titleSuggestions), 최종 선택 제목, 단계별 부가 정보 등.
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- types/database.ts의 KEYWORD_STATUSES에서 'discovered'만 뺀 집합이다.
  -- job은 "선택된 순간" 생기므로 discovered 상태가 존재할 수 없다.
  constraint article_jobs_status_check
    check (status in ('selected', 'researching', 'writing', 'review', 'approved', 'published', 'rejected')),
  constraint article_jobs_selected_via_check
    check (selected_via in ('telegram', 'manual', 'dashboard'))
);

-- 중복 클릭 방어: 같은 run의 같은 순위를 여러 번 눌러도 job은 하나만 생긴다.
-- ArticleJobRepository가 이 index 위반을 "이미 선택됨"으로 해석해 멱등 처리한다.
drop index if exists public.uq_article_jobs_run_rank;
create unique index uq_article_jobs_run_rank
  on public.article_jobs (source_run_id, source_rank);

create index if not exists idx_article_jobs_status
  on public.article_jobs (status);
create index if not exists idx_article_jobs_selected_at
  on public.article_jobs (selected_at desc);
-- "아직 처리 안 된 job을 오래된 순으로" 조회하는 다음 단계 워커의 주 접근 패턴.
create index if not exists idx_article_jobs_pending
  on public.article_jobs (status, selected_at)
  where status in ('selected', 'researching', 'writing', 'review');

comment on table public.article_jobs is 'Telegram에서 선택된 키워드 1건 = 원고 job 1건. 조사->집필->이미지->검수->발행 전 단계의 상태 머신. keyword_rankings를 참조하지 않고 선택 시점 값을 복사해 보관한다.';
comment on column public.article_jobs.source_run_id is '선택 당시 discovery_runs.id. FK로 묶지 않는다(run 스냅샷은 정리 대상, job은 장기 생존).';
comment on column public.article_jobs.source_rank is '선택 당시 keyword_rankings.rank. (source_run_id, source_rank)가 중복 클릭 방어 키다.';
comment on column public.article_jobs.status is 'selected | researching | writing | review | approved | published | rejected.';
comment on column public.article_jobs.selected_via is '선택 경로. 현재는 telegram만 사용한다.';
comment on column public.article_jobs.metadata is '추천 제목(titleSuggestions), 최종 제목, 단계별 부가 정보.';

-- ---------- telegram_offsets ----------
-- Telegram getUpdates의 커서(offset)를 보관한다.
--
-- 왜 DB인가: 수신기를 launchd로 짧게 여러 번 실행하는 방식(SPRINT_1_DESIGN.md 6절)이라 프로세스가
-- 매번 죽는다. offset을 메모리에 둘 수 없고, 파일로 두면 나중에 수신기를 다른 호스트로 옮길 때
-- 따라오지 않는다. row가 극소수라 테이블 비용은 무시할 수준이다.

create table if not exists public.telegram_offsets (
  -- 논리적 수신기 이름. 수신기가 여러 개로 늘어나도 서로의 커서를 침범하지 않게 한다.
  id text primary key,
  -- 마지막으로 처리한 update_id. 다음 getUpdates는 offset = last_update_id + 1로 호출한다.
  last_update_id bigint not null,
  updated_at timestamptz not null default now()
);

comment on table public.telegram_offsets is 'Telegram getUpdates 커서. 수신기가 짧게 반복 실행되므로 offset을 DB에 보관한다.';
comment on column public.telegram_offsets.id is '논리적 수신기 이름(예: keyword-bot).';
comment on column public.telegram_offsets.last_update_id is '마지막으로 처리 완료한 update_id. 다음 호출은 이 값 + 1을 offset으로 쓴다.';

-- ---------- 권한 ----------
-- 이 파이프라인은 서버의 service_role client만 사용한다. public Data API를 통해 anon/authenticated가
-- 접근할 이유가 없으므로 RLS를 켜고 두 role의 기본 권한을 제거한다(trend_candidates와 동일 정책).

alter table public.article_jobs enable row level security;
revoke all on table public.article_jobs from anon, authenticated;
grant select, insert, update, delete on table public.article_jobs to service_role;

alter table public.telegram_offsets enable row level security;
revoke all on table public.telegram_offsets from anon, authenticated;
grant select, insert, update, delete on table public.telegram_offsets to service_role;
