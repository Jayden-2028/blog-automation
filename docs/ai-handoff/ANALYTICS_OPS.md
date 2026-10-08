# 측정·분석 운영 (2026-10-08, 브랜치 feat/analytics-ops)

지시서: `ANALYTICS-OPS-2026-10.md`. 이 문서는 구현 결과와 **GA4 수집 설계안(승인 대기)**, 대시보드용 쿼리를 모은다.

## 1. 구현됨

| 항목 | 위치 |
|---|---|
| GSC 다중 속성 수집 | `collectSearchPerformanceCli.ts` — env `GSC_SITE_URLS`(콤마, 순서대로) → 없으면 `GSC_SITE_URL` 폴백. `--site=`로 한 속성만 |
| 색인 점검 다중 속성 | `checkIndexHealthCli.ts` — 속성별 점검·속성별 메시지(`belongsToSite`로 타 채널 URL 제외) |
| 주간 리포트 | `weeklyReport.ts`(순수) + `weeklyReportCli.ts` — 속성별 이번 주 vs 전주, 톱 쿼리·페이지 5개, 클릭 급락 경보, 14일 미만은 "축적 중" |
| 발화 | 새 cron 없음. `analytics-index-health.yml`(월 01:00 UTC)에 리포트 step 동승. Worker cron은 4/5 그대로 |

테이블 변경 없음: `page_url`에 도메인이 있어 unique `(date,page_url,query)` 그대로 3속성이 공존한다. 속성 = `page_url` 호스트.

**색인 신규/이탈 수(지시서 D)는 미구현**: 색인 점검이 상태를 저장하지 않아 전주 대비 증감을 알 수 없다. 현재 색인됨/대기/고장 수는 같은 날 색인 점검 메시지에 나온다. 증감이 필요하면 `index_health_weekly` 테이블(migration, 승인 게이트)이 필요하다 — 이번 범위에서는 제안만.

## 2. GA4 일일 수집 설계안 (승인 요청)

### 인증
- **서비스 계정 권장**: 기존 GSC용 서비스 계정을 재사용한다(같은 GCP 프로젝트 `blog-automation`).
  1. GCP에서 **Google Analytics Data API** 사용 설정(무료).
  2. GA4 각 속성 `관리 → 속성 액세스 관리`에 서비스 계정 이메일을 **뷰어**로 추가(사용자 작업, 속성 2개).
  3. 코드는 `SearchConsoleClient`와 같은 JWT 방식, 스코프만 `analytics.readonly`.
- 추가 secrets: **없음**(기존 `GSC_SERVICE_ACCOUNT_JSON` 재사용). 추가 repo variable 1개:
  `GA4_PROPERTY_IDS` = `채널라벨:숫자속성ID` 콤마 목록(예: `tkm:123456789,tistory:987654321`). 숫자 속성 ID는 측정 ID(`G-…`)와 다르다(`관리 → 속성 설정`).
- OAuth는 쓰지 않는다(refresh token 만료 이슈, GSC와 같은 판단).

### 수집 쿼리
`properties/{id}:runReport`, 하루 단위, dimensions: `date`, `sessionDefaultChannelGroup` / metrics: `sessions`, `totalUsers`, `screenPageViews`. 지연 약 1일 → 기준일은 2일 전, 최근 3일을 매번 upsert로 덮어 보정 반영.

### 테이블 (migration — 승인 필요)
```sql
create table if not exists public.ga4_performance_daily (
  date            date    not null,
  property_label  text    not null,   -- 'tkm' | 'tistory' 등 GA4_PROPERTY_IDS 라벨
  channel_group   text    not null,   -- Organic Search / Direct / Referral / ...
  sessions        integer not null default 0,
  total_users     integer not null default 0,
  page_views      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (date, property_label, channel_group)
);
create index if not exists idx_ga4_perf_date on public.ga4_performance_daily (date desc);
alter table public.ga4_performance_daily enable row level security;  -- search_performance_daily와 동일하게 service role만
```
되돌리기: `drop table public.ga4_performance_daily;` (신규 테이블이라 다른 것에 영향 없음).

### 단계
1. (승인 전) `analytics:ga4` 미리보기 CLI — `--apply` 없이 출력만. 이번 브랜치에서는 서비스 계정 권한이 없어 실호출 검증은 불가.
2. (승인 후) migration 적용 → `--apply` 적재 → 워크플로 `analytics-search.yml`에 동승(같은 00:30 UTC 디스패치).

## 3. 대시보드 원천 — 채널×일자×지표 한 쿼리

GSC 기반(지금 가능). 채널 = `page_url` 호스트:

```sql
select date,
       split_part(split_part(page_url, '://', 2), '/', 1) as channel,
       sum(clicks)      as clicks,
       sum(impressions) as impressions,
       sum(clicks)::float / nullif(sum(impressions), 0)           as ctr,
       sum(position * impressions) / nullif(sum(impressions), 0)  as position
from public.search_performance_daily
where date >= current_date - 30
group by 1, 2
order by 1 desc, 2;
```

GA4 적재 후(방문 지표, 채널 그룹 포함):

```sql
select date, property_label as channel,
       sum(sessions) as sessions, sum(total_users) as users, sum(page_views) as page_views
from public.ga4_performance_daily
where date >= current_date - 30
group by 1, 2 order by 1 desc, 2;
```

필요하면 위를 `view`로 만들 수 있다(migration이라 승인 후). 지금은 쿼리 예시만 제공한다.

## 4. 네이버 조회수 연계 메모 (설계만, 손대지 않음)

네이버 블로그는 GSC·GA4 대상이 아니다. 맥미니 Creator Advisor 수집(다른 세션 소유)이 일자별 조회수를 얻을 수 있다면, 같은 모양의 `channel × date × views` 행으로 별도 테이블에 쌓아 위 두 쿼리와 `union all`로 붙이는 것이 가장 단순하다. 폴러·plist는 이 세션이 건드리지 않는다. 소유 세션과 협의해 컬럼(`date, channel, views`)만 합의하면 된다.
