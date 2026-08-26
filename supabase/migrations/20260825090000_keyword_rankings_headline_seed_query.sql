-- keyword_rankings에 canonical keyword와 별도로 원본 headline / seed query를 보존하기 위한 컬럼 추가.
-- 기존에는 keyword 컬럼에 뉴스/블로그 title 전체(긴 headline)를 그대로 저장했는데, 이제 keyword는
-- canonicalKeyword.ts가 만든 짧은 대표 검색어를 저장하고, 축약 전 원문은 headline에, 그 결과의
-- trend 데이터를 조회하는 데 쓰인 원래 seed 검색어는 seed_query에 별도로 보존한다.
--
-- 주의: 이 migration은 파일만 생성한 것이며, 이 단계에서 실제 Supabase 프로젝트에 아직 적용하지 않는다.
-- 적용 전까지는 saveRankingHistory.ts의 keyword_rankings insert가 알 수 없는 컬럼 오류로 실패하며,
-- runKeywordRanking()은 이를 감지해 ranking 결과 자체는 정상 반환하고 history 저장 실패만 별도로 보고한다.

alter table keyword_rankings
  add column if not exists headline text,
  add column if not exists seed_query text;

comment on column keyword_rankings.keyword is 'canonical keyword(canonicalKeyword.ts로 headline을 축약한 짧은 대표 검색어). 포스팅/알림 등 외부 소비자가 그대로 쓰는 값.';
comment on column keyword_rankings.headline is 'cluster의 대표 원본 headline(뉴스/블로그 title 원문, 축약 전).';
comment on column keyword_rankings.seed_query is '이 결과의 trend 데이터를 조회하는 데 사용된 원래 seed 검색어. candidate에 query metadata가 없으면 null.';
