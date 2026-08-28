-- Sprint 2: 자료조사/원고 생성이 article_jobs와 이어지도록 sources/articles에 컬럼을 추가한다.
-- 설계 근거는 docs/ai-handoff/SPRINT_2_DESIGN.md 3절, 4절 참고.
--
-- 주의: 이 migration은 파일만 작성한 것이며, 실제 Supabase 프로젝트 적용은 사용자 승인 후에 한다.

-- ---------- sources.job_id / sources.authority ----------
--
-- 왜 필요한가: sources/articles는 keyword_id(int, keywords.id 참조)로 설계돼 있는데, 이 파이프라인은
-- keywords 테이블에 아무것도 쓰지 않는다(랭킹 단계는 keyword_rankings에만 저장한다). 그래서
-- keyword_id는 항상 null이 되어 원고를 job과 이을 방법이 없었다.
--
-- FK 제약을 걸지 않는 이유: article_jobs가 나중에 정리돼도 수집한 근거·작성한 원고는 남아야 한다.
-- 이는 article_jobs가 keyword_rankings를 FK로 참조하지 않고 값을 복사한 것과 같은 판단이다.
--
-- keyword_id는 건드리지 않는다 - 기존 testCrud 테스트 데이터(articles/sources 각 2건)가 이 컬럼을
-- 쓰고 있고, 나중에 이 파이프라인이 keywords 테이블을 쓰게 되면 그때 다시 쓸 수 있다.

alter table public.sources
  add column if not exists job_id uuid;

-- 실측 확인(2026-08-27): 같은 검색 파이프라인이라도 주제에 따라 근거 품질이 완전히 다르다.
-- "2026 근로장려금 지급일"은 웹문서 검색 10건 중 9건이 정부 공식 도메인(hometax.go.kr 등)이었지만,
-- "아기 셔더링어택 증상"은 10건 전부 네이버 인플루언서 블로그·커뮤니티였다(공공 0, 의료 0).
-- 이 차이를 데이터로 남겨야 원고 프롬프트와 검수, 의학 주제 교차확인 알림이 등급을 근거로 판단할 수 있다.
alter table public.sources
  add column if not exists authority text;

alter table public.sources
  drop constraint if exists sources_authority_check;
alter table public.sources
  add constraint sources_authority_check
    check (authority is null or authority in ('official', 'medical', 'news', 'community'));

comment on column public.sources.job_id is 'article_jobs.id. FK 제약 없음 - job이 정리돼도 수집한 근거는 남아야 한다.';
comment on column public.sources.authority is '출처 등급: official(.go.kr/.or.kr/.re.kr) | medical(의료기관 화이트리스트) | news(뉴스 검색 결과) | community(그 외 블로그/카페/커뮤니티). null이면 미분류(과거 데이터).';

create index if not exists idx_sources_job_id on public.sources (job_id);

-- ---------- articles.job_id ----------

alter table public.articles
  add column if not exists job_id uuid;

comment on column public.articles.job_id is 'article_jobs.id. FK 제약 없음(sources.job_id와 같은 이유).';

create index if not exists idx_articles_job_id on public.articles (job_id);
