-- GA4 일일 방문 지표 원장(2026-10-09, 측정·분석 §C).
--
-- search_performance_daily(GSC, 검색 노출·클릭)와 짝이다 - 이쪽은 실제 방문(세션·사용자·조회수)이다.
-- 한 행 = (날짜, 속성 라벨, 채널 그룹). 속성 라벨은 GA4_PROPERTY_IDS의 라벨(tkm, tistory 등).
-- 같은 날짜를 다시 받아도 중복이 쌓이지 않는다 - GA4도 며칠간 수치를 보정하므로 upsert가 정상 동작이다.

create table if not exists public.ga4_performance_daily (
  date            date    not null,
  property_label  text    not null,
  -- GA4 sessionDefaultChannelGroup: Organic Search / Direct / Referral / Organic Social / ...
  channel_group   text    not null,
  sessions        integer not null default 0,
  total_users     integer not null default 0,
  page_views      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (date, property_label, channel_group)
);

create index if not exists idx_ga4_perf_date on public.ga4_performance_daily (date desc);

comment on table public.ga4_performance_daily is
  'GA4 일일 방문 지표. 한 행 = (날짜, 속성 라벨, 채널 그룹). GA4 Data API runReport 결과를 upsert한다.';
comment on column public.ga4_performance_daily.property_label is 'GA4_PROPERTY_IDS의 라벨(tkm, tistory ...). 숫자 속성 ID가 아니다.';

-- ---------- 권한 ----------
-- 다른 테이블과 동일 - service_role만 접근한다.
alter table public.ga4_performance_daily enable row level security;
revoke all on table public.ga4_performance_daily from anon, authenticated;
grant select, insert, update, delete on table public.ga4_performance_daily to service_role;
