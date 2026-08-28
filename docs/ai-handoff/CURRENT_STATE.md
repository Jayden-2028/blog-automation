# Claude Code 인수인계 상태

기준일: 2026-08-26 (Asia/Seoul)

## 한 줄 상태

**Sprint 0 완주.** 매일 09:00 launchd가 키워드 TOP 10을 Telegram으로 보내는 파이프라인이 실제로
동작한다(무인 job 전 구간 검증 완료, run #17). 다음은 Sprint 1(Telegram 인라인 버튼 선택 루프).

## 지금 돌아가는 것

```
pmset(08:55 자동 기상) -> launchd(09:00) -> caffeinate -i -> npm run job:daily-keyword
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
매일 09:00, `RunAtLoad=false`, 로그는 `logs/daily-keyword.log`에 append.

해제: `launchctl bootout gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword`

**최초 08:00 등록분은 실패했다 - 아래 "운영 노트: 잠자기로 인한 조용한 실패" 참고.**

## 운영 노트: 잠자기로 인한 조용한 실패 (2026-08-27)

첫 자동 실행(08-27 08:22)이 실패했다. 사용자는 "맥이 꺼져 있어서 발송이 안 됐다"고 판단했지만
실제로는 **job이 실행됐다가 도중에 죽은 것**이었다. 로그를 직접 열어보고서야 알았다.

### 무슨 일이 있었나

```
[trendCollect] 5초   성공  <- trend_candidates에 205행 실제로 저장됨
[seed]         0.1초 성공
[collect]      70초   ...  <- 여기서 프로세스가 통째로 사라짐
(이후 로그 없음)
```

`discovery_runs`에 새 row가 없고, 로그에 `❌ ... 단계 실패`도 없었다. 예외였다면 `runStage`가
잡아서 기록했을 것이므로, **예외가 아니라 강제 종료**였다.

### 근본 원인

```
$ pmset -g custom
 sleep  1      <- 유휴 1분 후 시스템 잠자기
```

이 맥은 유휴 1분이면 잠든다. 그런데 launchd로 띄운 백그라운드 job은 **전원 assertion을 잡지
않는다.** 맥이 08:22에 (시스템 알람으로) 잠깐 깨어나 job을 시작했지만, 1분 뒤 다시 잠들면서
70초짜리 collect 단계가 죽었다.

### 해결

plist의 `ProgramArguments`를 `caffeinate -i`로 감쌌다:

```
/usr/bin/caffeinate -i /opt/homebrew/bin/npm run job:daily-keyword
```

`-i`는 **이 job이 도는 동안에만** 유휴 잠자기를 막고 job이 끝나면 assertion이 사라진다.
맥의 전역 전원 설정(`pmset sleep`)은 건드리지 않는다.

추가로 실행 시각을 09:00으로 옮기고, 맥이 스스로 깨어나도록 예약 기상을 걸었다:

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 08:55:00   # 해제: sudo pmset repeat cancel
```

전체 체인: `08:55 pmset 기상` -> `09:00 launchd 발화` -> `caffeinate -i`가 85초 실행 보호

### 검증 방법 (다음에도 이렇게 하면 된다)

내일 아침을 기다릴 필요 없다. `kickstart`는 launchd의 **실제 실행 환경**(PATH, cwd, 비대화형
세션)으로 즉시 실행한다:

```bash
launchctl kickstart gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword
launchctl print gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword | grep -E "runs|last exit"
```

이 방법으로 검증한 결과 8단계 전부 success, `last exit code = 0`, 85초, run #18 Telegram 발송
완료였다. 이 과정에서 **Playwright가 비대화형 launchd 세션에서도 정상 동작한다**는 것도 확인됐다
(가장 우려하던 위험이었다).

### 여기서 배운 것

**강제 종료된 프로세스는 실패 알림을 보낼 수 없다.** 어제 만든 알림(`notifyPipelineFailure`)은
예외를 잡아서 보내는 구조라 이런 조용한 죽음을 못 잡는다. `caffeinate`가 이 시나리오를 크게
줄여주지만 완전히 없애지는 못한다(전원 차단, 강제 재부팅 등). 근본 해결은 "오늘 성공한 run이
없으면 알린다"는 외부 감시인데, 감시자가 같은 맥에 있으면 같은 문제를 겪는다 - 클라우드로
나가야 하며 Sprint 1의 텔레그램 수신 서버 설계와 함께 다룬다.

## 검증된 명령 (2026-08-26 전부 green)

```
npm run build
npm run test:score-keyword               # 신규 - freshness 불변식
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

1. **~~6-factor 중 2개가 죽어 있다~~ — 오진단이었음(2026-08-26 정정).**
   `news`/`cross`가 88% 0점인 것은 결함이 아니라 희소 발화 보너스로 설계된 대로 동작하는 것이다.
   run 15/16/17 데이터로 확인: 발화한 8건은 평균 3.6위/56.6점, 발화 안 한 22건은 6.2위/51.5점.
   발화 항목이 전부 실제로 가장 뉴스성 높은 것들이었다(양준모 재혼, 민음사 빵, 장동윤 결혼).
   **손대지 말 것 - 건드리면 변별력이 사라진다.**
2. **~~freshness 계산이 뒤집혀 있다~~ — 해결됨(2026-08-26).**
   `neutralScoreRatio`를 0.5 → 0.2로 낮춰 발행일 없음이 8점 → 3점이 되었다.
   이제 `발행일 없음(3) < 당일 발행(7)`. `test:score-keyword`가 이 불변식을 고정하며, 0.5로
   되돌리면 실제로 실패하는 것까지 확인했다.
   `TREND_MOMENTUM_CONFIG.neutralScoreRatio: 0.4`도 같은 패턴이라 확인했으나, `unknown`(12점)이
   관측된 모든 값(17~30)보다 낮아 실제 역전이 없어 손대지 않았다.
3. **Top 10에 같은 주제가 2번씩 들어간다.** `DIVERSITY_CONFIG.maxPerSeedQuery = 2` 설정대로 동작
   중이다. 1로 낮추면 10개 주제가 되지만, 후보가 얕은 날 품질 낮은 키워드가 밀려 들어올 수 있어
   며칠 운영 후 판단하기로 했다.
4. **맥이 09:00에 완전히 꺼져 있으면 여전히 실행되지 않는다.** `caffeinate`는 "도는 중에 잠들지
   않게" 할 뿐 "깨우지는" 못하고, `pmset repeat`도 전원이 차단된 상태에서는 한계가 있다.
   더 큰 문제는 **강제 종료 시 실패 알림이 나가지 않는다**는 점이다(위 운영 노트 참고).
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
