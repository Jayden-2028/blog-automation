-- Legacy trend_candidates -> final Creator Advisor candidate schema upgrade.
--
-- 이 별도 migration이 필요한 이유:
-- 원격 프로젝트에는 previous_rank/collected_date를 쓰던 구형 trend_candidates가 이미 존재하지만,
-- 로컬 20260825150000 version이 원격 migration history에 어떤 상태로 기록됐는지는 아직 확인되지
-- 않았다. 이미 기록된 version의 파일을 수정해도 다시 실행되지 않으므로, 이 후속 version이 legacy와
-- fresh 환경 모두에서 같은 최종 스키마를 보장한다.
--
-- 이 파일은 idempotent하게 작성했다. table이 없으면 최종 형태로 만들고, legacy table이면 누락 컬럼을
-- 추가/backfill한 뒤 유도 가능한 구 컬럼을 제거한다. 실제 원격 적용 전 migration history 확인이 필요하다.

create extension if not exists pgcrypto;

create table if not exists public.trend_candidates (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  keyword_normalized text not null,
  topic text not null,
  topic_normalized text not null,
  source text not null default 'creator_advisor',
  trend_date date not null,
  rank integer not null,
  movement_type text not null,
  rank_change integer,
  candidate_score numeric,
  collected_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trend_candidates_status_check
    check (status in ('active', 'expired', 'archived')),
  constraint trend_candidates_movement_type_check
    check (movement_type in ('new', 'up', 'down', 'flat'))
);

-- create table if not exists는 legacy table의 shape를 바꾸지 않으므로 누락 컬럼을 명시적으로 추가한다.
alter table public.trend_candidates
  add column if not exists trend_date date,
  add column if not exists movement_type text,
  add column if not exists candidate_score numeric;

-- Fresh schema에는 collected_date가 없으므로 column 존재 여부를 확인한 뒤 dynamic SQL에서만 참조한다.
do $$
begin
  if exists (
    select 1
    from pg_attribute
    where attrelid = 'public.trend_candidates'::regclass
      and attname = 'collected_date'
      and not attisdropped
  ) then
    execute $sql$
      update public.trend_candidates
      set trend_date = coalesce(trend_date, collected_date, collected_at::date, current_date)
      where trend_date is null
    $sql$;
  else
    update public.trend_candidates
    set trend_date = coalesce(trend_date, collected_at::date, current_date)
    where trend_date is null;
  end if;
end
$$;

update public.trend_candidates
set
  topic = coalesce(nullif(btrim(topic), ''), 'unknown'),
  rank = coalesce(rank, 1),
  movement_type = case
    when movement_type in ('new', 'up', 'down', 'flat') then movement_type
    when rank_change is null then 'new'
    when rank_change > 0 then 'up'
    when rank_change < 0 then 'down'
    else 'flat'
  end;

-- src/config/creatorAdvisorCandidateScore.ts의 현재 pre-score와 동일하다.
update public.trend_candidates
set candidate_score =
  case
    when rank <= 3 then 20
    when rank <= 6 then 15
    when rank <= 10 then 10
    when rank <= 20 then 5
    else 2
  end
  + case movement_type
      when 'new' then 15
      when 'up' then 5
      when 'flat' then 5
      else 0
    end
  + case
      when movement_type = 'up' and coalesce(rank_change, 0) >= 50 then 10
      when movement_type = 'up' and coalesce(rank_change, 0) >= 20 then 7
      when movement_type = 'up' and coalesce(rank_change, 0) >= 5 then 3
      else 0
    end
where candidate_score is null;

alter table public.trend_candidates
  alter column topic set not null,
  alter column rank set not null,
  alter column trend_date set not null,
  alter column movement_type set not null,
  alter column source set default 'creator_advisor',
  alter column collected_at set default now(),
  alter column status set default 'active',
  alter column metadata set default '{}'::jsonb,
  alter column created_at set default now(),
  alter column updated_at set default now();

-- legacy 정보는 모두 새 컬럼으로 backfill됐고 previous_rank는 rank + rank_change로 유도 가능하다.
alter table public.trend_candidates
  drop column if exists previous_rank,
  drop column if exists collected_date;

drop index if exists public.uq_trend_candidates_keyword_topic_collected_date_source;

-- create table이 skip된 legacy 경로에서도 최종 check definition을 보장한다.
alter table public.trend_candidates
  drop constraint if exists trend_candidates_status_check,
  drop constraint if exists trend_candidates_movement_type_check;

alter table public.trend_candidates
  add constraint trend_candidates_status_check
    check (status in ('active', 'expired', 'archived')),
  add constraint trend_candidates_movement_type_check
    check (movement_type in ('new', 'up', 'down', 'flat'));

drop index if exists public.uq_trend_candidates_keyword_topic_date_source;
create unique index uq_trend_candidates_keyword_topic_date_source
  on public.trend_candidates (keyword_normalized, topic_normalized, trend_date, source);

create index if not exists idx_trend_candidates_trend_date
  on public.trend_candidates (trend_date desc);
create index if not exists idx_trend_candidates_status
  on public.trend_candidates (status);
create index if not exists idx_trend_candidates_source
  on public.trend_candidates (source);
create index if not exists idx_trend_candidates_topic_normalized
  on public.trend_candidates (topic_normalized);
create index if not exists idx_trend_candidates_candidate_score
  on public.trend_candidates (candidate_score desc);
create index if not exists idx_trend_candidates_active_source_date_score
  on public.trend_candidates (source, trend_date desc, candidate_score desc)
  where status = 'active';

alter table public.trend_candidates enable row level security;
revoke all on table public.trend_candidates from anon, authenticated;
grant select, insert, update, delete on table public.trend_candidates to service_role;

comment on table public.trend_candidates is 'NAVER Creator Advisor 트렌드 탭에서 수집한 동적 키워드 후보. daily query pool의 두 번째 입력원(seed_queries + trend_candidates).';
comment on column public.trend_candidates.keyword_normalized is 'lower(trim(keyword)). upsertCandidates()의 dedupe/conflict target 컬럼.';
comment on column public.trend_candidates.topic is 'Creator Advisor topic card의 실제 표시 제목 원문.';
comment on column public.trend_candidates.topic_normalized is '내부 category mapping 결과 또는 lower(trim(topic)).';
comment on column public.trend_candidates.trend_date is 'Creator Advisor가 표시하는 트렌드 기준일. 수집 시각과 다를 수 있다.';
comment on column public.trend_candidates.movement_type is 'new | up | down | flat.';
comment on column public.trend_candidates.rank_change is 'up=양수, down=음수, new=null, flat=0.';
comment on column public.trend_candidates.candidate_score is 'Creator Advisor 전용 pre-score. keyword_rankings의 최종 score와 무관.';
