-- Google Search Console 일일 성과 원장(2026-09-21).
--
-- 왜 필요한가: 지금까지 "어떤 키워드가 실제로 검색 유입을 만드는가"를 측정할 방법이 없었다.
-- 6-factor 점수는 발행 **전** 추정이고, 발행 후 결과가 돌아오지 않아 학습 루프가 닫히지 않았다
-- (CURRENT_STATE.md "발행 + Search Console이 붙어야 학습 루프가 생긴다").
--
-- 한 행 = (날짜, 글 주소, 검색어) 하나의 성과. GSC의 최소 단위를 그대로 옮긴다.

create table if not exists public.search_performance_daily (
  id bigserial primary key,

  -- GSC 기준 날짜(Asia/Seoul). 데이터가 2~3일 지연돼 들어오므로 수집일과 다르다.
  date date not null,

  -- 쿼리스트링을 떼어 정규화한 주소. Blogger는 모바일을 `?m=1`로 돌려 같은 글이 두 줄로 오는데,
  -- 그대로 두면 글 하나의 성과가 쪼개진다 - 코드에서 합친 뒤 저장한다(normalizeSearchRows.ts).
  page_url text not null,

  -- 사용자가 실제로 검색창에 친 말.
  query text not null,

  clicks integer not null default 0,
  impressions integer not null default 0,
  -- GSC 원본은 0~1 비율이다. 퍼센트로 바꾸지 않고 그대로 둔다(변환은 보는 쪽에서).
  ctr numeric(10, 8) not null default 0,
  -- 노출 가중 평균 순위. 모바일/데스크톱을 합칠 때도 가중 평균을 유지한다.
  position numeric(8, 3) not null default 0,

  -- 어느 원고에서 나온 성과인지. FK로 묶지 않는다(api_usage와 같은 이유 - job이 정리돼도
  -- 성과 기록은 남아야 한다). 매칭 실패 시 null - 사람이 Blogger에서 직접 올린 글이 여기 해당한다.
  job_id uuid,

  fetched_at timestamptz not null default now(),

  -- 같은 날짜를 다시 받아도 중복이 쌓이지 않게 한다. GSC는 발표 후 며칠간 수치를 보정하므로
  -- **재수집이 정상 동작**이다 - upsert로 덮어쓸 수 있어야 한다.
  unique (date, page_url, query)
);

-- 질의는 대부분 "최근 N일"과 "이 글의 추이"다.
create index if not exists idx_search_perf_date on public.search_performance_daily (date desc);
create index if not exists idx_search_perf_page_date on public.search_performance_daily (page_url, date desc);
create index if not exists idx_search_perf_job on public.search_performance_daily (job_id) where job_id is not null;

comment on table public.search_performance_daily is
  'Search Console 일일 성과. 한 행 = (날짜, 글 주소, 검색어). 모바일(?m=1)은 코드에서 합쳐 저장한다.';
comment on column public.search_performance_daily.page_url is '쿼리스트링을 뗀 정규화 주소.';
comment on column public.search_performance_daily.ctr is 'GSC 원본 비율(0~1). 퍼센트 아님.';
comment on column public.search_performance_daily.position is '노출 가중 평균 순위. 낮을수록 좋다.';
comment on column public.search_performance_daily.job_id is 'article_jobs.id. FK 아님 - 매칭 실패면 null(수동 발행 글).';

-- ---------- 권한 ----------
-- 다른 테이블과 동일 - service_role만 접근한다.
alter table public.search_performance_daily enable row level security;
revoke all on table public.search_performance_daily from anon, authenticated;
grant select, insert, update, delete on table public.search_performance_daily to service_role;
