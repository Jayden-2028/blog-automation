-- Keyword Ranking 실행 이력을 보존하기 위한 테이블.
-- discovery_runs: runKeywordRanking() 1회 실행(batch) 단위 메타데이터.
-- keyword_rankings: 각 실행에서 산출된 keyword(cluster)별 랭킹 "스냅샷" — keywords 테이블 등 다른
--   테이블의 현재 상태에 의존하지 않고, 랭킹 당시의 keyword/category/sources/score_breakdown/
--   trend_direction/related_count/latest_published_at 값을 그대로 저장해 나중에도 랭킹 결과를
--   완전히 재현할 수 있게 한다.
--
-- 주의: 이 migration은 파일만 생성/수정한 것이며, 이 단계에서 실제 Supabase 프로젝트에 아직 적용하지 않는다.
-- 적용 전까지는 discoveryRunRepository.ts, keywordRankingRepository.ts를 통한 호출이 실패하며,
-- runKeywordRanking()은 이를 감지해 ranking 결과 자체는 정상 반환하고 history 저장 실패만 별도로 보고한다.

create table if not exists discovery_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null default 'running',
  candidates_count integer not null default 0,
  clusters_count integer not null default 0,
  inserted_count integer not null default 0,
  error_count integer not null default 0,
  source text not null default 'naver',
  seed_queries jsonb,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint discovery_runs_status_check
    check (status in ('running', 'completed', 'failed'))
);

comment on table discovery_runs is 'keyword ranking 파이프라인(runKeywordRanking) 1회 실행 단위 메타데이터';
comment on column discovery_runs.status is 'running | completed | failed';
comment on column discovery_runs.source is '이 run이 어느 데이터 소스 기반인지 (예: naver). 기본 naver.';
comment on column discovery_runs.seed_queries is '이 run에 사용된 seed 검색어 목록 (jsonb 문자열 배열).';
comment on column discovery_runs.metadata is '기타 실행 옵션/부가 정보 (예: displayPerQuery, trendRangeDays 등). jsonb.';

create index if not exists idx_discovery_runs_started_at
  on discovery_runs (started_at desc);

create index if not exists idx_discovery_runs_created_at
  on discovery_runs (created_at desc);

create table if not exists keyword_rankings (
  id bigint generated always as identity primary key,
  run_id bigint not null references discovery_runs (id) on delete cascade,

  -- keywords row와 1:1 매칭을 가정하지 않는다. ranking 단계는 keywords 테이블에 쓰지 않으므로
  -- keyword_id는 nullable로 유지하고, keyword/category 등은 아래처럼 값 자체를 스냅샷으로 저장한다.
  keyword_id bigint references keywords (id) on delete set null,

  keyword text not null,
  category text,

  rank integer not null,
  total_score numeric not null,

  trend_score numeric,
  news_score numeric,
  content_score numeric,
  freshness_score numeric,
  cross_source_score numeric,
  click_score numeric,

  trend_direction text,
  related_count integer default 0,

  sources jsonb,
  score_breakdown jsonb,

  reason text,
  latest_published_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table keyword_rankings is
  'discovery_runs 1회 실행에서 산출된 keyword(cluster)별 랭킹 스냅샷. keywords 테이블 상태와 무관하게 랭킹 당시 값을 그대로 보존해 나중에도 완전히 재현 가능하게 한다.';
comment on column keyword_rankings.keyword_id is 'keywords 테이블에 대응 row가 저장된 경우에만 연결됨. ranking 단계는 keywords 테이블에 쓰지 않으므로 대부분 null이며, 랭킹 결과가 keywords row와 1:1로 매칭된다고 가정하지 않는다.';
comment on column keyword_rankings.sources is '해당 cluster가 등장한 source 목록 (예: ["naver_news", "naver_blog"]). jsonb 문자열 배열.';
comment on column keyword_rankings.score_breakdown is 'scoreKeyword()가 산출한 항목별 원점수 전체 스냅샷 (jsonb: trendMomentum/newsVelocity/contentDemand/freshness/crossSourceSignal/clickPotential/total).';

create index if not exists idx_keyword_rankings_run_id
  on keyword_rankings (run_id);

create index if not exists idx_keyword_rankings_keyword_id
  on keyword_rankings (keyword_id);

create index if not exists idx_keyword_rankings_run_rank
  on keyword_rankings (run_id, rank);

create index if not exists idx_keyword_rankings_keyword
  on keyword_rankings (keyword);

create index if not exists idx_keyword_rankings_total_score
  on keyword_rankings (total_score desc);

create index if not exists idx_keyword_rankings_created_at
  on keyword_rankings (created_at desc);
