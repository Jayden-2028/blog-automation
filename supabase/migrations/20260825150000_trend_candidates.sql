-- NAVER Creator Advisor 트렌드 탭에서 수집한 동적 키워드 후보를 저장하는 테이블.
-- daily query pool의 두 번째 입력원(기존 seed_queries가 첫 번째, stable/base 검색어)으로 쓰인다.
-- src/repositories/TrendCandidateRepository.ts가 이 테이블을 통해 후보를 upsert/조회/만료 처리한다.
--
-- 2026-08-26 실측 확인을 반영해 최종 확정한 스키마(이전 초안에서 변경된 점):
-- - collected_date(수집 시각의 날짜) 대신 trend_date(Creator Advisor가 표시하는 트렌드 기준일)를
--   dedupe 키로 쓴다 - 최신 날짜 데이터가 아직 준비되지 않아 하루 전 날짜로 fallback하는 경우가
--   실측으로 확인됐고(trendDateNavigation.ts), "언제 수집했는지"(collected_at)와 "어느 날짜의
--   트렌드인지"(trend_date)가 다를 수 있다.
-- - movement_type(new/up/down/flat)을 별도 컬럼으로 저장한다 - rank_change만으로는 flat(0)과
--   "변동 정보 없음"을 구분할 수 없고, up/down 여부를 case-insensitive 부호 판독 없이 바로 조회할 수
--   있어야 candidate_score 계산/조회가 쉬워진다.
-- - candidate_score(Creator Advisor 전용 pre-score, config/creatorAdvisorCandidateScore.ts)를 저장한다.
--   기존 keyword_rankings의 6-factor 최종 점수와는 완전히 별개이며, NAVER API 검증 대상 상위 후보를
--   고르는 데만 쓰인다.
-- - previous_rank 컬럼은 제거했다 - rank + rank_change로 항상 유도 가능해 별도 저장할 필요가 없다
--   (movement_type='new'면 이전 순위 자체가 없다는 뜻).
--
-- 주의: 이 migration은 파일만 최종 확정한 것이며, 이 단계에서 실제 Supabase 프로젝트에 아직
-- 적용하지 않는다.

create extension if not exists pgcrypto;

create table if not exists trend_candidates (
  id uuid primary key default gen_random_uuid(),

  keyword text not null,
  -- lower(trim(keyword)). dedupe/upsert conflict target에 쓰기 위해 앱에서 계산해 저장한다.
  -- (seed_queries는 lower(trim(keyword))로 만든 "expression" unique index만으로 충분했지만,
  --  trend_candidates는 TrendCandidateRepository.upsertCandidates()가 매일 재수집 결과를
  --  upsert해야 하고, PostgREST upsert의 onConflict 대상은 실제 컬럼 목록이어야 expression
  --  index를 안전하게 재사용할 수 없다. 그래서 정규화 값을 일반 컬럼으로 별도 저장한다.)
  keyword_normalized text not null,

  -- Creator Advisor trends 페이지의 실제 topic card 제목 원문 그대로 저장한다(예: "육아·결혼").
  -- 내부 category(ott/parenting/living/entertainment 등)로의 매핑은 topic_normalized에만 반영하고,
  -- topic 원본은 그대로 보존한다(요구사항: "원본 topic은 반드시 별도 보존").
  topic text not null,
  -- 내부 category mapping 결과(creatorAdvisorTopicMapping.ts 참고) 또는 그런 매핑이 없으면
  -- lower(trim(topic)). keyword_normalized와 같은 이유로 별도 컬럼(upsert conflict target).
  topic_normalized text not null,

  source text not null default 'creator_advisor',

  -- Creator Advisor가 표시하는 트렌드 기준일("이 keyword가 몇 월 며칠 트렌드인지"). 수집 시각
  -- (collected_at)과는 다를 수 있다 - 최신 날짜에 데이터가 아직 없어 하루 전으로 fallback한 경우
  -- trend_date는 그 fallback된 날짜다(예: 수집은 8/25에 했지만 trend_date=2026-08-24).
  trend_date date not null,

  -- topic card 내 .u_ni_trend_item 순서 기반 순위(1-based).
  rank integer not null,
  -- .u_ni_data의 classList로 판정한 등락 상태. up/down/new 중 아무 class도 없으면 flat.
  movement_type text not null,
  -- up=양수, down=음수, new=null, flat=0.
  rank_change integer,

  -- Creator Advisor 전용 pre-score(0~100 근방, config/creatorAdvisorCandidateScore.ts).
  -- NAVER API 검증 대상 상위 후보를 고르는 데만 쓰인다 - keyword_rankings의 6-factor 최종
  -- score(scoreKeyword.ts)와는 완전히 별개이며 서로 영향을 주지 않는다.
  candidate_score numeric,

  collected_at timestamptz not null default now(),
  -- 이 후보를 daily query pool에서 더 이상 쓰지 않을 시각. config/creatorAdvisor.ts의
  -- candidateTtlHours 기준으로 수집 시 계산해 채운다. null이면 expireOldCandidates()가 만료
  -- 대상으로 보지 않는다.
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

-- 이 파이프라인은 서버의 service_role client만 사용한다. public Data API를 통해 anon/authenticated가
-- 접근할 이유가 없으므로 RLS를 켜고 두 client role의 기본 권한을 제거한다. service_role은 서버 전용이며
-- RLS를 우회하지만, Data API 기본 권한 설정과 무관하게 동작하도록 필요한 table 권한을 명시한다.
alter table public.trend_candidates enable row level security;
revoke all on table public.trend_candidates from anon, authenticated;
grant select, insert, update, delete on table public.trend_candidates to service_role;

comment on table trend_candidates is 'NAVER Creator Advisor 트렌드 탭에서 수집한 동적 키워드 후보. daily query pool의 두 번째 입력원(seed_queries + trend_candidates). source 기본값은 creator_advisor.';
comment on column trend_candidates.keyword_normalized is 'lower(trim(keyword)). upsertCandidates()의 dedupe/conflict target 컬럼.';
comment on column trend_candidates.topic is 'Creator Advisor topic card의 실제 표시 제목 원문(예: "육아·결혼"). 내부 category 매핑과 무관하게 항상 원본 그대로 보존한다.';
comment on column trend_candidates.topic_normalized is '내부 category mapping 결과 또는 lower(trim(topic)). upsertCandidates()의 dedupe/conflict target 컬럼.';
comment on column trend_candidates.trend_date is 'Creator Advisor가 표시하는 트렌드 기준일. 최신 날짜 데이터가 아직 없어 fallback한 경우 실제 사용된 날짜가 들어간다(collected_at과 다를 수 있음).';
comment on column trend_candidates.rank is 'Creator Advisor 트렌드 탭에서의 topic 내 순위(topic card 내부 순서 기반, 1-based).';
comment on column trend_candidates.movement_type is 'new | up | down | flat. .u_ni_data의 classList로 판정(▲/▼ 문자 비의존).';
comment on column trend_candidates.rank_change is 'up=양수, down=음수, new=null, flat=0.';
comment on column trend_candidates.candidate_score is 'Creator Advisor 전용 pre-score(NAVER API 검증 대상 선별용). keyword_rankings의 6-factor 최종 score와 무관.';
comment on column trend_candidates.expires_at is 'config/creatorAdvisor.ts의 candidateTtlHours 기준으로 수집 시 계산해 채운다. null이면 expireOldCandidates()가 만료 대상으로 보지 않는다.';
comment on column trend_candidates.status is 'active | expired | archived. listCandidatesByTrendDate()/listLatestActiveCandidates()는 기본적으로 active만 반환한다.';

-- dedupe 기준: 같은 (keyword_normalized, topic_normalized, trend_date, source) 조합은 한 row만
-- 허용한다. upsertCandidates()는 on conflict (이 4개 컬럼) do update로 같은 트렌드 기준일에 대해
-- 재수집한 rank/movement_type/candidate_score 등을 최신 값으로 안전하게 갱신한다.
create unique index if not exists uq_trend_candidates_keyword_topic_date_source
  on trend_candidates (keyword_normalized, topic_normalized, trend_date, source);

comment on index uq_trend_candidates_keyword_topic_date_source is
  'trend_candidates 중복 방지: 같은 (keyword_normalized, topic_normalized, trend_date, source) 조합은 한 row만 허용. upsertCandidates()가 이 index를 on conflict target으로 사용한다.';

create index if not exists idx_trend_candidates_trend_date
  on trend_candidates (trend_date desc);

create index if not exists idx_trend_candidates_status
  on trend_candidates (status);

create index if not exists idx_trend_candidates_source
  on trend_candidates (source);

create index if not exists idx_trend_candidates_topic_normalized
  on trend_candidates (topic_normalized);

create index if not exists idx_trend_candidates_candidate_score
  on trend_candidates (candidate_score desc);
