-- keyword ranking 파이프라인의 seed 검색어를 코드 내부 배열(naverCategoryMap.ts의
-- DEFAULT_CATEGORY_BY_QUERY 등) 대신 DB에서 관리하기 위한 테이블.
-- SeedQueryRepository.ts(src/repositories/)가 이 테이블을 통해 seed를 조회/등록/상태 변경한다.
--
-- 주의: 이 migration은 파일만 생성한 것이며, 이 단계에서 실제 Supabase 프로젝트에 아직 적용하지 않는다.
-- 적용 전까지는 SeedQueryRepository.ts를 통한 호출이 실패한다.

create extension if not exists pgcrypto;

create table if not exists seed_queries (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  category text not null,
  priority integer not null default 5,
  status text not null default 'active',
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seed_queries_status_check
    check (status in ('active', 'paused', 'archived'))
);

comment on table seed_queries is 'keyword ranking 파이프라인이 사용하는 seed 검색어 목록. runDailyKeywordWorkflow()가 기본 queries로 SeedQueryRepository.getActiveSeeds()를 사용한다.';
comment on column seed_queries.priority is '조회/정렬 우선순위. 숫자가 클수록 우선순위가 높다. 기본 5.';
comment on column seed_queries.status is 'active | paused | archived. getActiveSeeds()는 active만 반환한다.';
comment on column seed_queries.source is '이 seed가 어떻게 등록되었는지 (예: manual, trend-auto 등). 기본 manual.';

create index if not exists idx_seed_queries_status
  on seed_queries (status);

create index if not exists idx_seed_queries_category
  on seed_queries (category);

create index if not exists idx_seed_queries_priority
  on seed_queries (priority desc);
