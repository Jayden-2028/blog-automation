# Claude Code 인수인계 상태

기준일: 2026-08-26 (Asia/Seoul)

## 한 줄 상태

**Sprint 0 완주.** 매일 08:00 launchd가 키워드 TOP 10을 Telegram으로 보내는 파이프라인이 실제로
동작한다(무인 job 전 구간 검증 완료, run #17). 다음은 Sprint 1(Telegram 인라인 버튼 선택 루프).

## 지금 돌아가는 것

```
launchd(매일 08:00) -> npm run job:daily-keyword
  [trendCollect] Creator Advisor 크롤링 -> trend_candidates upsert  (~5초, 220건)
  [seed]         seed_queries(44) + trend_candidates(40) = 84건
  [collect]      NAVER 검색 API -> 후보 ~2100건                      (~70초)
  [relevance]    seed 관련성 필터 -> ~900건
  [cluster]      유사도 클러스터링 -> ~400개
  [rank]         6-factor scoring + diversity -> Top 10
  [save]         discovery_runs + keyword_rankings
  [notify]       Telegram 발송
실패 시 -> Telegram으로 단계별 실패 알림 (실발송 검증 완료)
```

전체 소요 약 80초. `trendCollect` 실패는 비치명적으로 처리되어 job을 죽이지 않는다.

## 2026-08-26 세션에서 한 일

### 1. Supabase migration 적용 (승인 후)

`20260826024112_upgrade_legacy_trend_candidates.sql`을 Dashboard SQL Editor에서 단독 실행.
Supabase CLI 미설치 + `.env`에 DB 비밀번호 없음 → CLI 경로 불가. `db push`는 원격 history가
비어 있어 여전히 **금지**.

검증 통과: 컬럼 3개 추가/2개 제거, NOT NULL 10개, unique index, RLS on, service_role 권한,
row 0 유지, 다른 테이블 row 수 전부 보존.

### 2. 문서에 없던 원격 테이블 2개 발견

- `images` (article_id, image_url, source, **copyright_status**, alt_text) → Sprint 3에서
  `article_assets`를 새로 만들지 말고 이걸 재사용한다.
- `analytics` (publication_id, views, likes, comments, collected_at) → Sprint 5 통계용.
- **둘 다 `src/types/database.ts`에 정의가 없다**(원격 10개 / 코드 8개). 타입 갭 미해결.
- `articles`/`sources`/`publications`의 각 2행은 `testCrud script`가 남긴 테스트 데이터.

### 3. 누락된 배선 구현

크롤링/변환/저장 조각은 다 있었으나 **프로덕션에서 이어 호출하는 코드가 없었다.**
`buildDailyQueryPool`이 아무도 쓰지 않는 테이블을 읽고 있었다.

- 신규 `workflows/creator-advisor/runCreatorAdvisorCollection.ts` — 실패해도 throw하지 않고
  `status`로만 알림. `dryRun`으로 DB 쓰기 없이 크롤링만 검증 가능.
- `dailyKeywordWorkflow.ts`에 `trendCollect` 단계를 `seed` 앞에 non-blocking 삽입.
- 신규 CLI `collect:creator-advisor` (기본 dry-run, `WRITE=1`로 실제 저장).

### 4. Creator Advisor 파서 근본 원인 해결 (0건 → 220건)

**근본 원인**: `checkCurrentDateStatus()`가 **전역** `.u_ni_trend_item` 개수로 준비 완료를 판정했다.
성별·연령별(demographic) card가 topic card보다 먼저 채워지므로, topic card가 전부 비어 있는
시점에 전역 60개를 보고 "available"로 오판하고 그 HTML을 캡처했다.

| 시점 | cards | topicRows | globalRows |
|---|---|---|---|
| 렌더 대기 직후 | 22 | 0 | 0 |
| 화면 상태 전환 직후 | 33 | 0 | 60 ← 오판 지점 |
| +2초 | 33 | 60 | 120 |

**수정**: `trendsPageReadiness.ts`에 `measureTopicCardRows()` / `waitForTopicCardRowsSettled()` 추가.
전역이 아니라 **비-demographic topic card 안의 row**를 기준으로 카드별 시그니처가 안정될 때까지
폴링한다(고정 sleep 아님). `DEMOGRAPHIC_TITLE_PATTERN`을 export해 Node/브라우저가 같은 정규식을 쓴다.

**Swiper 순회 추가**(Codex 위임 → Claude 검증): `.u_ni_search_swiper`가 2개(topic 11 / demographic 22)로
**서로 다른 인스턴스**이고, 루트 요소에 `element.swiper`가 살아 있어 버튼 없이 `slideTo(index)`로
제어 가능하다. Creator Advisor는 card를 전부 DOM에 만들되 viewport 주변 3장만 row를 채우므로
(lazy) 순회 없이는 3개 topic만 얻는다. `traverseTopicSwiper()`가 전 슬라이드를 순회한다.

`maxTopics` 기본값 4 → **11**. 4로 두면 영화·일상·생각 등 주요 분야가 통째로 빠진다.

**결과**: 11 topic × 20 = 220건, topicErrors 0건, 약 5초.

### 5. 카테고리 오분류 해결

Creator Advisor는 category를 **topic card 단위로만** 준다. 그래서 `육아·결혼` 카드 20건이 전부
`parenting`이 되었고, 실제로는 **진짜 육아가 7건뿐**이었다(나머지는 정부 지원금과 연예 뉴스).

신규 `config/keywordCategoryRules.ts` — 키워드 어휘로 먼저 판정하고, 확실한 신호가 없을 때만
topic 매핑으로 폴백한다. 순서가 우선순위다(entertainment > ott > parenting > living):
- "양준모 재혼 상대 양지원, 임신 소식"은 "임신"이 있어도 연예 뉴스 → entertainment
- "아동수당 신청방법"은 "신청"이 있어도 육아 정보 → parenting

부수 효과로 같은 키워드가 카드마다 다른 category로 흩어지던 문제도 해결(중복 병합 11 → 15건).

**남은 한계**: `윤남노 복담주`, `수원 라뷔포레`, `루치아나바로소` 등 고유명사는 어휘 규칙으로
잡을 수 없어 topic 폴백을 탄다. 인명 사전이나 LLM 분류가 필요한 영역이라 규칙을 늘리지 않았다.

### 6. upsert 배치 내 conflict key 충돌 해결

unique index는 `(keyword_normalized, topic_normalized, trend_date, source)`인데 `topic_normalized`는
매핑된 카테고리다. topic 11개가 카테고리 4개로 축소되므로(living 하나에 6개) 같은 키워드가 같은
카테고리의 두 topic에 나오면 한 배치에 conflict key가 겹쳐 PostgreSQL이 **배치 전체를 거부**한다
(`ON CONFLICT DO UPDATE command cannot affect row a second time`, 21000).

`dedupeTrendCandidateInserts()`로 upsert 전에 병합한다. 승자는 pre-score가 높은 쪽(동점이면 rank가
앞선 쪽), 버려지는 쪽의 topic은 `metadata.mergedFrom`에 보존.

### 7. 에러 직렬화 결함 수정

Supabase(PostgrestError)는 `Error` 인스턴스가 아니라 평범한 객체라 `String(error)`가
`[object Object]`를 만들어 실패 원인이 통째로 사라졌다. **이걸 고치지 않았으면 6번 원인을
못 찾았다.** `message`/`code`/`details`/`hint`를 보존한다.

### 8. 실패 알림 구현 + 검증

이전에는 job이 실패해도 로그 파일에만 남고 조용히 죽었다. 신규
`notifications/notifyPipelineFailure.ts`가 단계별 결과를 Telegram으로 보낸다.
`dailyKeywordJob.ts` 안에 두면 import만으로 job이 실행돼 테스트할 수 없어서 별도 모듈로 분리했다.
**실제 발송까지 검증 완료.**

### 9. launchd 등록

`~/Library/LaunchAgents/com.wooahpapa.blog-automation.daily-keyword.plist`
매일 08:00, `RunAtLoad=false`, 로그는 `logs/daily-keyword.log`에 append.

해제: `launchctl bootout gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword`

## 검증된 명령 (2026-08-26 전부 green)

```
npm run build
npm run test:keyword-category            # 신규 - 실제 수집 키워드 24건
npm run test:creator-advisor-parser
npm run test:creator-advisor-pipeline
npm run test:creator-advisor-collection  # 신규 - 배선/실패격리/dedupe 7케이스
npm run test:daily-query-pool
npm run test:notification
npm run test:failure-notification        # 신규 - SEND=1로 실발송
npm run test:keywords
npm run test:naver
npm run test:ranking

npm run collect:creator-advisor          # 신규, 기본 dry-run / WRITE=1로 저장
npm run debug:ca-snapshots               # 신규, DOM 스냅샷 -> .local/dom-snapshots/
```

`test:naver`/`test:keywords`/`test:ranking`은 외부 NAVER API를 실제 호출한다.
`test:trend-candidate-repository`는 원격 쓰기가 가능하므로 `ALLOW_SUPABASE_WRITE_TEST=1`은
별도 승인 시에만 사용한다.

## ⚠️ 이름이 오해를 부르는 것

**`npm run dryrun:daily-keyword`는 dry-run이 아니다.** Telegram만 dry-run이고,
`saveRankingHistory`에 write guard가 없어 `discovery_runs`/`keyword_rankings`에 실제로 쓴다.

## 현재 원격 DB 상태

| 테이블 | 행 수 |
|---|---|
| discovery_runs | 16 |
| keyword_rankings | 133 |
| trend_candidates | 215 (active 205 / archived 10) |
| seed_queries | 44 |
| keywords | 38 |
| articles / sources / publications | 각 2 (testCrud 잔재) |
| images / analytics | 0 |

`archived` 10행은 카테고리 수정 전 버전이다. active 조회에서 제외되므로 무해하다.

## 알려진 문제 / 미해결

1. **6-factor 중 2개가 거의 죽어 있다.** seed-only일 때 `news`/`cross`가 10개 전부 0점이었다
   (배점 100 중 30). Creator Advisor를 켜면 부분적으로 살아난다(news 3/10, cross 2/10).
   뉴스와 블로그 클러스터가 잘 병합되지 않는 것이 원인으로 보인다. **scoring 영역이라 승인 필요.**
2. **freshness 계산이 뒤집혀 있다.** 발행일이 없으면 `neutralScoreRatio 0.5` → 15 × 0.5 = **8점**,
   오늘 발행한 글은 15 × 0.5^(12/12) = **7점**. "날짜 모름"이 "오늘 발행"을 이긴다.
   seed-only run #14에서 나무위키·보건복지부 랜딩·2023년 글이 Top 10에 오른 직접 원인.
   **scoring 영역이라 승인 필요.**
3. **Top 10에 같은 주제가 2번씩 들어간다.** `DIVERSITY_CONFIG.maxPerSeedQuery = 2` 설정대로 동작
   중이다. 1로 낮추면 10개 주제가 되지만, 후보가 얕은 날 품질 낮은 키워드가 밀려 들어올 수 있어
   며칠 운영 후 판단하기로 했다.
4. **맥이 자거나 꺼져 있으면 08:00 실행이 건너뛰어진다.** launchd의 구조적 한계.
   Creator Advisor 크롤링이 로그인된 브라우저 프로필에 묶여 있어 클라우드 이전이 단순하지 않다.
5. `images`/`analytics` 타입 정의 없음 (Codex 위임 적합).
6. Supabase CLI 미설치. migration history와 로컬 파일이 계속 어긋나 있다.
7. 테스트에 assertion 프레임워크가 없다(console.log + assert 헬퍼).
8. `parseTrendHtml.ts` 상단 주석의 "topic과 demographic이 같은 swiper 인스턴스"는 실측과 어긋날
   가능성이 있으나 확정 근거가 부족해 수정하지 않았다.

## n8n 도입 검토 결과

**지금은 도입하지 않는다.** 오늘 겪은 문제(파서 준비 판정, 카테고리 매핑, upsert 충돌, 에러 직렬화)는
전부 도메인 로직이라 오케스트레이터를 바꿔도 그대로 남는다. `dailyKeywordWorkflow.ts`가 이미
stage log·실패 격리·비치명적 단계 구분을 하고 있고, Playwright 크롤링은 n8n 노드와 잘 맞지 않는다.
채널이 늘어 분기·재시도가 많아지는 Sprint 4~5에 재검토한다. 클라우드 이전이 목적이라면 n8n보다
GitHub Actions가 더 맞다(이미 npm 스크립트라 `cron` + `npm run job:daily-keyword`면 된다).

## 다음: Sprint 1 (선택 루프 닫기)

- `notifications/TelegramBot.ts` — `getUpdates` long-polling 수신기. 발송 전용
  `TelegramNotifier`는 그대로 두고 별도 클래스로.
- 알림 메시지에 인라인 버튼 부착. callback_data = `sel:<run_id>:<rank>`
- `article_jobs` 테이블 — 선택된 키워드 1건 = job 1건. 이후 단계의 상태 머신.
  기존 `KEYWORD_STATUSES`(discovered→selected→…→published) 재사용.
- `generateTitleSuggestions.ts`의 `[placeholder]`를 실제 LLM 생성으로 교체.

전체 로드맵: `/Users/wooahpapa/.claude/plans/gpt-recursive-squirrel.md`
