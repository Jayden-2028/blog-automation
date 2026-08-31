-- Sprint 5: 다채널 발행. 승인된 네이버 원고 1건을 소스로, 티스토리·Blogspot 각각의 SEO에 맞춘
-- OSMU 배리에이션 원고를 만든다. 배리에이션은 articles의 새 row로 저장하고 platform으로 구분한다
-- (SPRINT_5_DESIGN.md §7 결정 A1).
--
-- 주의: 이 migration은 파일 작성 후 사용자 승인을 받아 `supabase db push`로 적용한다.

-- ---------- articles.platform ----------
--
-- null   = 기준 원고(네이버). 지금까지 만들어진 모든 원고가 여기에 해당한다(백필 불필요).
-- 'blogspot' / 'tistory' = 그 채널용 배리에이션.
--
-- FK/CHECK 제약을 걸지 않는 이유:
--  - 채널이 늘 때마다 migration을 강제하지 않기 위함(trend_candidates.source가 text인 것과 같은 판단).
--  - unique (job_id, platform)도 걸지 않는다 - 같은 job의 기준 원고가 재작성으로 여러 건 남을 수
--    있어(articleRepository.listArticlesByJobId 주석) platform=null 행이 복수로 존재할 수 있다.
--    배리에이션 중복은 publications(article_id + platform) 멱등성 검사로 막는다.

alter table public.articles
  add column if not exists platform text;

comment on column public.articles.platform is
  'null=기준 원고(네이버). blogspot/tistory=해당 채널용 OSMU 배리에이션(SPRINT_5_DESIGN.md §7).';

-- job별 배리에이션 조회를 위한 인덱스(publishApprovedArticles가 자주 읽는다).
create index if not exists idx_articles_job_platform on public.articles (job_id, platform);
