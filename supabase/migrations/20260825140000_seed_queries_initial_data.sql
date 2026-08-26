-- 운영용 초기 Seed Pool.
-- 4개 주요 콘텐츠 분야(OTT/영화/드라마, 육아 정보, 생활정보/지원금/정책/날씨, 연예/방송/가십)에
-- 대응하는 category(ott/parenting/living/entertainment)별로, 특정 작품명/연예인 이름 위주가 아니라
-- 장기간 재사용 가능한 evergreen 검색 seed 위주로 구성했다.
--
-- priority 기준:
--   10 = 핵심 seed (해당 분야를 대표하는 최상위 키워드)
--    7 = 중요 seed
--    5 = 보조 seed
-- 모두 status='active', source='manual'.
--
-- 이 migration은 20260825130000_seed_queries_dedupe_unique_index.sql이 만든
-- uq_seed_queries_keyword_category(lower(trim(keyword)), category) unique index를 전제로,
-- on conflict ... do nothing을 사용해 여러 번 실행해도 데이터가 중복 삽입되지 않도록 설계했다.
-- (그 migration이 먼저 적용되어 있지 않으면 이 INSERT의 on conflict 대상이 존재하지 않아 실패한다.)
--
-- 주의: 이 migration은 파일만 생성한 것이며, 이 단계에서 실제 Supabase 프로젝트에 아직 적용하지 않는다.

insert into seed_queries (keyword, category, priority, status, source)
values
  -- ---------- ott: OTT / 영화 / 드라마 ----------
  ('넷플릭스', 'ott', 10, 'active', 'manual'),
  ('디즈니플러스', 'ott', 10, 'active', 'manual'),
  ('티빙', 'ott', 10, 'active', 'manual'),
  ('웨이브', 'ott', 7, 'active', 'manual'),
  ('쿠팡플레이', 'ott', 7, 'active', 'manual'),
  ('넷플릭스 신작', 'ott', 7, 'active', 'manual'),
  ('신작 드라마', 'ott', 7, 'active', 'manual'),
  ('신작 영화', 'ott', 7, 'active', 'manual'),
  ('넷플릭스 공개 예정', 'ott', 5, 'active', 'manual'),
  ('OTT 요금', 'ott', 5, 'active', 'manual'),
  ('드라마 출연진', 'ott', 5, 'active', 'manual'),

  -- ---------- parenting: 육아 정보 ----------
  ('육아지원금', 'parenting', 10, 'active', 'manual'),
  ('부모급여', 'parenting', 10, 'active', 'manual'),
  ('아동수당', 'parenting', 10, 'active', 'manual'),
  ('출산지원금', 'parenting', 7, 'active', 'manual'),
  ('육아휴직', 'parenting', 7, 'active', 'manual'),
  ('어린이집', 'parenting', 7, 'active', 'manual'),
  ('유치원', 'parenting', 5, 'active', 'manual'),
  ('아이 건강', 'parenting', 5, 'active', 'manual'),
  ('육아 정책', 'parenting', 5, 'active', 'manual'),
  ('출산 정책', 'parenting', 5, 'active', 'manual'),

  -- ---------- living: 생활정보 / 지원금 / 정책 / 날씨 ----------
  ('정부지원금', 'living', 10, 'active', 'manual'),
  ('청년지원금', 'living', 10, 'active', 'manual'),
  ('오늘 날씨', 'living', 10, 'active', 'manual'),
  ('소상공인지원금', 'living', 7, 'active', 'manual'),
  ('민생지원금', 'living', 7, 'active', 'manual'),
  ('정책 변경', 'living', 7, 'active', 'manual'),
  ('정부 정책', 'living', 7, 'active', 'manual'),
  ('폭염', 'living', 7, 'active', 'manual'),
  ('전기요금', 'living', 7, 'active', 'manual'),
  ('태풍', 'living', 5, 'active', 'manual'),
  ('장마', 'living', 5, 'active', 'manual'),
  ('교통비', 'living', 5, 'active', 'manual'),
  ('신청 방법', 'living', 5, 'active', 'manual'),

  -- ---------- entertainment: 연예 / 방송 / 가십 ----------
  ('연예계', 'entertainment', 7, 'active', 'manual'),
  ('배우', 'entertainment', 7, 'active', 'manual'),
  ('아이돌', 'entertainment', 7, 'active', 'manual'),
  ('예능', 'entertainment', 7, 'active', 'manual'),
  ('연예인 근황', 'entertainment', 7, 'active', 'manual'),
  ('연예인 논란', 'entertainment', 5, 'active', 'manual'),
  ('열애', 'entertainment', 5, 'active', 'manual'),
  ('결혼', 'entertainment', 5, 'active', 'manual'),
  ('이혼', 'entertainment', 5, 'active', 'manual'),
  ('방송', 'entertainment', 5, 'active', 'manual')
on conflict (lower(trim(keyword)), category) do nothing;
