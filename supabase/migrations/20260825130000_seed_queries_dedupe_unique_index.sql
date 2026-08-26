-- seed_queries 중복 방지: lower(trim(keyword)) + category 조합이 유일하도록 강제한다.
-- (예: "넷플릭스"/" 넷플릭스 "/"넷플릭스 "가 같은 category로 여러 번 들어가는 것을 막는다.)
--
-- 이 migration은 기존 스키마를 위험하게 바꾸지 않기 위해, unique index를 만들기 전에
-- 먼저 현재 데이터에 lower(trim(keyword))+category 기준 중복이 있는지 확인하고,
-- 있으면 unique index 생성 전에 명확한 에러 메시지와 함께 migration 자체를 중단시킨다.
-- (중복이 있는 상태로 바로 create unique index를 실행하면 postgres가 어떤 row가
--  문제인지 알려주지 않는 일반적인 unique violation 에러만 던지기 때문.)
--
-- 중복이 있다면 아래 쿼리로 어떤 row들이 충돌하는지 먼저 확인:
--   select lower(trim(keyword)) as k, category, count(*), array_agg(id order by created_at)
--   from seed_queries
--   group by lower(trim(keyword)), category
--   having count(*) > 1;
--
-- 주의: 이 migration은 파일만 생성한 것이며, 이 단계에서 실제 Supabase 프로젝트에 아직 적용하지 않는다.

do $$
declare
  dup_count integer;
begin
  select count(*) into dup_count
  from (
    select lower(trim(keyword)) as k, category
    from seed_queries
    group by lower(trim(keyword)), category
    having count(*) > 1
  ) dupes;

  if dup_count > 0 then
    raise exception
      'seed_queries에 lower(trim(keyword))+category 기준 중복 % 건이 있어 unique index를 생성할 수 없습니다. '
      '먼저 중복 row를 정리한 뒤 이 migration을 다시 적용하세요. '
      '확인 쿼리: select lower(trim(keyword)) k, category, count(*), array_agg(id order by created_at) '
      'from seed_queries group by lower(trim(keyword)), category having count(*) > 1;',
      dup_count;
  end if;
end $$;

create unique index if not exists uq_seed_queries_keyword_category
  on seed_queries (lower(trim(keyword)), category);

comment on index uq_seed_queries_keyword_category is
  'seed_queries 중복 방지: 같은 (lower(trim(keyword)), category) 조합은 한 row만 허용. INSERT 시 on conflict (lower(trim(keyword)), category) do nothing 으로 안전하게 재실행 가능.';
