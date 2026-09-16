-- 유료 API 호출 1건 = row 1건. 대시보드(manuscripts/cost.json)가 이 테이블만 보고 비용을 집계한다.
--
-- 배경(2026-09-16 사용자 요청): "블로그 자동화에 들어간 모든 솔루션 비용을 개인 대시보드에서
-- 실시간으로 보고 싶다". 조사해 보니 공급자가 주는 청구액 API는 두 가지 이유로 단독으로는 못 쓴다.
--   1) OpenAI Costs API(/v1/organization/costs)는 **하루 단위 버킷 + 수 시간 지연**이라 "실시간"이
--      아니고, Admin key(조직 전체 읽기 권한)라는 강한 자격증명을 따로 발급해야 한다.
--   2) Gemini는 키 단위 사용량/비용 조회 API가 아예 없다(Cloud Billing -> BigQuery export 경로뿐).
-- 그래서 **우리가 호출 시점에 직접 계측하는 쪽이 본체**다. 응답에 이미 실려 오는 usage(토큰 수)를
-- 지금은 그냥 버리고 있었다(generateImage.ts가 data만 읽었다) - 그 값을 단가표에 곱해 여기 남긴다.
--
-- 호출 즉시 1행이라 지연이 없고, provider가 달라도 같은 모양으로 쌓인다. 나중에 OpenAI Costs API로
-- 실제 청구액을 당겨와 대조할 때는 같은 테이블에 cost_source='reported'로 넣어 비교하면 된다
-- (그래서 cost_source 컬럼을 지금 만들어 둔다 - 나중에 컬럼을 추가하면 또 migration 승인 게이트다).
--
-- article_jobs를 FK로 참조하지 않는 이유: manuscript_manifest_topics와 같은 판단. 비용 원장은
-- job이 나중에 정리돼도 독립적으로 남아 있어야 한다(지출 기록이 사라지면 월 합계가 틀어진다).
--
-- 적용 완료: 2026-09-16, 사용자 승인 후 Supabase MCP(apply_migration)로 원격에 적용했다. 파일명 타임스탬프는
-- 원격 migration history에 기록된 version(20260916153725)에 맞춰 두었다 - 어긋나면 나중에
-- `supabase db push`가 이미 적용된 migration을 다시 실행하려 든다.

create table if not exists public.api_usage (
  id uuid primary key default gen_random_uuid(),

  -- 호출이 일어난 시각. 집계 기준(오늘/이번 달)은 전부 이 컬럼이다.
  occurred_at timestamptz not null default now(),

  -- "openai" | "gemini" | ... 자유 문자열로 둔다(새 공급자를 붙일 때 migration을 다시 하지 않도록).
  provider text not null,
  -- 실제로 호출한 모델 ID("gpt-image-2" 등). 단가표(src/config/apiPricing.ts)의 키와 같은 값이다.
  model text not null,
  -- 무엇을 했는지. "image.generate" | "research.generate" 처럼 <도메인>.<동작>으로 적는다.
  operation text not null,

  -- 응답의 usage를 그대로. 공급자가 안 주면 null(그 경우 cost_usd도 null이 된다 - 0으로 적으면
  -- "공짜였다"와 "모른다"가 구분되지 않아 합계가 조용히 과소집계된다).
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  -- 이미지 장수 등 토큰이 아닌 과금 단위. 지금은 참고용이고 금액 계산에는 쓰지 않는다.
  quantity integer not null default 1,

  -- 계측 금액(USD). 단가 미등록 모델이면 null - 대시보드가 "단가 미등록 N건"으로 따로 보여준다.
  cost_usd numeric(12, 6),
  -- "metered"  = 우리가 usage x 단가표로 계산한 값(실시간, 기본)
  -- "reported" = 공급자 청구액 API에서 받아온 값(하루 단위, 나중에 붙일 대조용)
  cost_source text not null default 'metered',

  -- 어느 원고 때문에 나간 비용인지. 원고 1건당 단가를 내려면 이게 있어야 한다.
  job_id uuid,

  -- 실패 사유, 단가 미등록 표시, 청구액 API 응답 원본 등 부가 정보.
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

-- 대시보드 질의는 항상 "최근 N일"이라 occurred_at 역순이 기본이다.
create index if not exists idx_api_usage_occurred_at on public.api_usage (occurred_at desc);
create index if not exists idx_api_usage_provider_occurred_at on public.api_usage (provider, occurred_at desc);
create index if not exists idx_api_usage_job_id on public.api_usage (job_id) where job_id is not null;

comment on table public.api_usage is
  '유료 API 호출 1건 = row 1건. 호출 시점에 직접 계측한 사용량과 금액을 남긴다(대시보드 cost.json의 단일 소스).';
comment on column public.api_usage.cost_usd is '계측 금액(USD). 단가 미등록이면 null - 0과 구분한다.';
comment on column public.api_usage.cost_source is 'metered=우리가 계산(실시간) / reported=공급자 청구액 API(대조용).';
comment on column public.api_usage.job_id is 'article_jobs.id. FK로 묶지 않는다 - job이 정리돼도 지출 기록은 남아야 한다.';

-- ---------- 권한 ----------
-- 다른 테이블과 동일 정책 - service_role만 접근, anon/authenticated는 차단.
-- (대시보드는 이 테이블을 직접 읽지 않는다. 집계 결과인 cost.json만 본다.)

alter table public.api_usage enable row level security;
revoke all on table public.api_usage from anon, authenticated;
grant select, insert, update, delete on table public.api_usage to service_role;
