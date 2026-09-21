-- 청구 기준(reported) 비용 행의 중복 방지(2026-09-21).
--
-- 배경: api_usage는 원래 "호출 1건 = row 1건"(cost_source='metered')으로 설계됐고,
-- cost_source='reported'는 "공급자 청구액을 하루 단위로 받아 넣을 자리"로 열어만 둔 상태였다.
-- 이제 Google Cloud 결제 데이터를 BigQuery 내보내기에서 읽어 그 자리에 채운다.
--
-- 왜 유니크 인덱스가 필요한가: 청구 데이터는 **확정이 아니라 나중에 정정된다**. 구글은 며칠 뒤
-- 크레딧·조정분을 반영해 같은 날짜의 금액을 다시 쓴다. 그래서 동기화는 매번 최근 며칠치를
-- 다시 읽어 upsert해야 하고, 그러려면 "같은 날 같은 서비스 같은 SKU"를 식별할 키가 있어야 한다.
-- 키가 없으면 돌릴 때마다 같은 날 비용이 중복으로 쌓여 합계가 부풀려진다.
--
-- metered 행에는 적용되지 않는다(부분 인덱스) - 실제 호출은 같은 초에 같은 모델로 여러 번
-- 일어날 수 있고 그건 정상이다.
--
-- ⚠️ 적재 코드는 reported 행의 provider/model/operation/occurred_at을 **반드시 채워야** 한다.
-- Postgres에서 null은 서로 다른 값으로 취급돼(nulls distinct) 하나라도 비면 중복을 못 막는다.
--
-- 되돌리기: drop index if exists public.uq_api_usage_reported_daily;

create unique index if not exists uq_api_usage_reported_daily
  on public.api_usage (provider, model, operation, occurred_at)
  where cost_source = 'reported';

comment on index public.uq_api_usage_reported_daily is
  '청구 기준 행의 upsert 키. (공급자, 서비스, SKU, 사용일) 하나당 한 줄 - 정정분은 덮어쓴다.';
