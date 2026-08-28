# Claude Code 인수인계 상태

기준일: 2026-08-28 (Asia/Seoul)

## 한 줄 상태

**Sprint 0·1·2 완료, Sprint 3(검수 게이트 + 이미지) 전 단계 완료.** 매일 09:00 키워드 TOP 10이
Telegram으로 오고, Go/Pass 버튼으로 선택하면 `article_jobs`가 생긴다. 거기서부터 조사 완료
알림의 `[✍️ 원고 작성][🗑 중단]` 버튼으로 원고 생성까지 이어지고, 그 안에서 **검수 규칙 4종이
자동으로 돌고**(차단은 아님, 결과만 알림에 표시) **AI 이미지 2~3장이 실사(photorealistic)
스타일로 자동 생성돼 본문에 삽입된 채로**(OpenAI `gpt-image-1` 기본) Telegraph에 발행된다 -
카테고리별 톤(entertainment/ott/parenting은 개인 블로그 톤, living은 편집자 톤, 실제 블로그
샘플 분석 기반)도 적용된다. `[✅ 승인][✏️ 수정 필요][🗑 반려]` 버튼(모든 원고 공통)으로
`job`/`article` status가 `approved`로 전이된다. 경복궁·아기 셔더링어택·재혼 황후·보조금24·
맥도날드 감튀 홀더 5건으로 전 구간 실측 검증 완료(이미지 포함 최종 형태는 맥도날드 건으로
확인). 상세는 `docs/ai-handoff/SPRINT_2_DESIGN.md` 14절과 `docs/ai-handoff/SPRINT_3_DESIGN.md`
13-1·14절.

**다음 작업: Sprint 4(네이버 반자동 발행) 구현 — 설계는 끝났고 결정 대기 중.**
`docs/ai-handoff/SPRINT_4_DESIGN.md` §9에 결정 항목 6건이 있다(트리거 방식, 발행 대상 블로그,
일일 발행 상한값, 쓰기 세션 최초 로그인 시점, 이미지 위치 타협안, 실측 단계 승인 방식). 이
스프린트는 처음으로 사람 계정으로 실제 쓰기 작업을 브라우저에서 하므로 §10의 1번(SmartEditor
DOM 실측)부터가 실제 네이버 세션을 여는 작업이다 - Creator Advisor 프로필과는 분리된 새
프로필(`.local/naver-publish-profile/`)로 사용자가 최초 1회 수동 로그인해야 한다.

## 지금 돌아가는 것

### 매일 아침: 키워드 수집 -> 알림

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
알림은 헤더 1건 + 항목 10건으로 나가고, 항목마다 `[✍️ Go] [⏭ Pass]` 버튼이 붙는다.

### 상시: 버튼 클릭 처리 (5분 주기)

```
launchd(StartInterval 300) -> caffeinate -i -> npm run job:telegram-poll
  getUpdates(offset)  -> telegram_offsets 커서 이후만
  callback 파싱       -> go / pass / (구)sel
  chat_id 검증        -> 다른 대화에서 온 것 거부
  keyword_rankings 재조회 -> 위조/만료 callback_data 거부
  article_jobs 기록   -> Go=selected / Pass=rejected
  claude -p 제목 생성 -> Go로 새로 만들어진 job에만
  확인 메시지 + 버튼 상태 갱신
```

처리할 update가 없으면 약 2초에 조용히 끝난다(로그도 남기지 않는다). Go 처리 시 제목 생성에
25초쯤 걸려 `caffeinate`가 필요하다.

## Sprint 1: 선택 루프 (2026-08-27 완료)

설계는 `docs/ai-handoff/SPRINT_1_DESIGN.md`. 확정된 두 결정은 주기적 폴링(맥 잠자기 회피)과
추천 제목의 선택-후 생성이다.

### 새 테이블 2개

- `article_jobs` — 선택된 키워드 1건 = job 1건. 이후 조사->집필->이미지->검수->발행 전 단계의
  상태 머신. `keyword_rankings`를 FK로 참조하지 않고 값을 복사한다(run 스냅샷은 정리 대상이지만
  job은 며칠~몇 주 살아 있어야 한다).
- `telegram_offsets` — getUpdates 커서. 수신기가 짧게 반복 실행되므로 메모리에 둘 수 없다.

둘 다 RLS on + anon/authenticated 권한 회수 + service_role 명시.

### 멱등성과 마음 바꾸기

`unique (source_run_id, source_rank)`로 중복 클릭을 막는다. upsert가 아니라 insert 후
unique violation(23505)을 잡는데, upsert는 기존 row를 덮어써서 이미 writing 단계인 job이 버튼
재클릭으로 selected로 리셋되기 때문이다.

`selected <-> rejected`는 서로 전환할 수 있다. 잘못 눌렀을 때 빠져나올 방법이 없으면 unique
index 때문에 그 항목이 영구히 막힌다. 다만 이미 researching/writing인 job은 `locked`로 거부한다.

### callback_data 규약

`go:<run_id>:<rank>` / `pass:<run_id>:<rank>`. 구 `sel:` 접두사는 go 별칭으로 계속 받는다
(이미 발송된 메시지의 버튼을 회수할 수 없다).

키워드를 넣지 않는 이유가 둘이다. Telegram의 64바이트 제한에 한글 키워드 하나로도 걸리고,
참조 키만 담으면 수신 측이 `keyword_rankings`에서 다시 읽어야 하는데 이것이 곧 검증이 된다 -
위조된 값으로 임의 키워드를 주입해도 조회되지 않으면 거부된다.

발송 측과 수신 측이 같은 형식을 써야 하므로 `notifications/telegramCallbackData.ts` 하나만
참조하게 했다. 각자 조립하면 한쪽만 바뀌었을 때 버튼이 조용히 죽는다.

### 헤드리스 LLM

`services/llm/runHeadlessClaude.ts`가 `claude -p`를 1회 실행한다. Sprint 2의 원고 생성도 같은
경로를 쓴다. API가 아니라 CLI인 이유는 기존 블로그 작성 스킬을 그대로 재사용하기 위해서다 -
프롬프트로 이식하면 스킬이 두 벌이 된다.

프롬프트는 argv가 아니라 stdin으로 넘기고(원고 길이에서 argv 제한·셸 이스케이프), 도구 사용은
기본 차단하며, 타임아웃을 반드시 건다.

### UX: 숫자 격자 -> 항목별 Go/Pass

처음에는 전체를 한 메시지에 담고 하단에 1~10 숫자 버튼을 달았는데, 폰에서 항목이 한 화면에 안
들어와 스크롤로 대조해야 했다. Telegram은 인라인 키보드를 메시지 단위로만 붙일 수 있어서, 항목
바로 아래 버튼을 두려면 항목마다 메시지가 따로 가야 한다(헤더 1 + 항목 10 = 11건, 6초).

Pass는 `rejected`로 기록한다. 다음 개선 지점이 키워드 품질인데 사용자가 실제로 무엇을 거부했는지가
가장 직접적인 신호이고, 지금 모으지 않으면 소급할 수 없다. Pass에서는 제목을 만들지 않는다.

### 실측 검증 (실제 폰 클릭)

  Go(rank 2,7)      -> selected + 제목 3개
  Pass(rank 6)      -> rejected, 제목 0개(LLM 호출 없음)
  중복 Go(rank 1,2) -> unchanged, job/제목 재생성 없음

5건 39초. 가장 위험하다고 본 헤드리스 제목 생성이 첫 실행에서 동작했고 출력 파싱도 깨끗했다.

### 알려진 한계

같은 run의 알림을 재발송하면 이미 결정된 항목의 버튼이 초기 상태로 보인다. 발송 시점에 기존
결정을 조회하지 않기 때문이다. 매일 새 run이 생기므로 실사용에서는 거의 나타나지 않고, 다시
눌러도 `unchanged`로 처리돼 데이터는 안전하다. 필요해지면 `ArticleJobRepository.listByRunId`를
발송 경로에 연결하면 된다.

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
npm run test:telegram-bot                # 신규 - callback 핸들러 9케이스
npm run test:callback-data               # 신규 - callback_data 규약
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
npm run job:telegram-poll                # 신규, 버튼 클릭 1회 수신 처리
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
5. ~~`images`/`analytics` 타입 정의 없음~~ — 해결됨(2026-08-27). `database.ts`가 12개 테이블을
   모두 안다. 다만 두 테이블의 `id`가 identity인지는 형제 테이블 관례로 추론한 것이라,
   처음 insert하는 시점(Sprint 3/5)에 실제로 확인해야 한다.
6. **같은 run 재발송 시 버튼 상태가 초기값으로 보인다.** 위 Sprint 1 "알려진 한계" 참고. 무해하다.
7. **버튼 반응까지 최대 5분 걸린다.** 주기적 폴링의 구조적 특성이고, `answerCallbackQuery`는
   그 시점에 만료돼 버튼 로딩 표시가 그냥 사라진다(확인 메시지는 정상 도착). 즉시 반응이
   필요해지면 클라우드 webhook으로 옮겨야 하는데, 핸들러가 수신 방식과 분리돼 있어 옮길 때
   버릴 코드는 거의 없다.
8. Supabase CLI 미설치. migration history와 로컬 파일이 계속 어긋나 있다.
9. 테스트에 assertion 프레임워크가 없다(console.log + assert 헬퍼).
10. `parseTrendHtml.ts` 상단 주석의 "topic과 demographic이 같은 swiper 인스턴스"는 실측과 어긋날
   가능성이 있으나 확정 근거가 부족해 수정하지 않았다.

## n8n 도입 검토 결과

**지금은 도입하지 않는다.** 오늘 겪은 문제(파서 준비 판정, 카테고리 매핑, upsert 충돌, 에러 직렬화)는
전부 도메인 로직이라 오케스트레이터를 바꿔도 그대로 남는다. `dailyKeywordWorkflow.ts`가 이미
stage log·실패 격리·비치명적 단계 구분을 하고 있고, Playwright 크롤링은 n8n 노드와 잘 맞지 않는다.
채널이 늘어 분기·재시도가 많아지는 Sprint 4~5에 재검토한다. 클라우드 이전이 목적이라면 n8n보다
GitHub Actions가 더 맞다(이미 npm 스크립트라 `cron` + `npm run job:daily-keyword`면 된다).

## Sprint 2: 자료조사 + 원고 생성 (진행 중, 2026-08-28)

설계는 `docs/ai-handoff/SPRINT_2_DESIGN.md`. 다음이 구현되고 경복궁·아기 셔더링어택·재혼 황후
3건으로 실측 검증됐다(커밋 `55bf97e` → `e1b953d` → `8f7540b` → `86c8996` → `d893113` →
`d2876ed` → `776c581`):

```
npm run job:research -- <jobId>   NAVER 재검색 + 공공 도메인 fetch -> sources 저장 ->
                                    LLM 요약(경고/사실/판단 3구간)을 Telegram으로 발송,
                                    [✍️ 원고 작성][🗑 중단] 버튼 부착
(사람이 확인 -> 버튼 클릭 또는 CLI)
npm run job:write -- <jobId>      저장된 sources를 재사용해 원고 생성(재조사 안 함) ->
                                    해시태그 15개 + (의학이면) 출처 신뢰도 고지 부착 ->
                                    Telegraph 발행 -> "📄 원고 보기" 버튼 발송
npm run job:reject -- <jobId>     가치가 없다고 판단되면 여기서 끝낸다(사유 기록)
```

원고 작성/중단은 이제 Telegram 버튼으로도 된다 - write 버튼은 `runWritingStage`(최대 수 분)를
`job:telegram-poll`의 콜백 처리 안에서 그대로 실행한다(Go 버튼의 제목 생성과 같은 패턴).

- **자료조사** (`workflows/research/`): 카테고리 무관 NAVER 뉴스/웹/블로그 재검색, 출처를
  official/medical/news/community 4등급으로 분류(`config/sourceAuthorityRules.ts`), official
  등급 URL은 본문을 직접 fetch해 스니펫을 보강한다(`fetchOfficialSourceContent.ts` — 네비게이션
  메뉴 오추출 결함을 고쳐 실제 예매 기간을 뽑아내는 것까지 검증됨, SPRINT_2_DESIGN.md 12/14-1절).
- **의학 주제**: 자동 배제하지 않고 생성하되, 판정되면(`config/medicalTopicRules.ts`)
  `requiresMedicalReview`가 붙어 Telegram에 "확인함/수정 필요/폐기" 버튼이 함께 간다(설계 5절).
- **집필** (`workflows/writing/`): `runHeadlessClaude`로 `moai-writer:korean-humanize` +
  `moai-marketer:content-blog` 스킬을 헤드리스 실행. 실측 원고 길이 1786자(목표 1500~2500 내),
  소요 185초.
- **체크포인트 도입 이유**: 첫 실측에서 대상 키워드("2026 경복궁 별빛야행")가 실제로는 이미 예매가
  마감된 이벤트였는데, 원고 생성 비용(3분)을 다 쓴 뒤에야 알게 됐다. 조사 직후 사람이 "이 근거로
  써도 될까요?"를 판단할 지점을 만들었다 (SPRINT_2_DESIGN.md 13/14-2절).
- **원고 확인**: Telegram 메시지는 마크다운을 서식으로 렌더링하지 않아 telegra.ph 페이지로 발행하고
  버튼으로 연결한다. 발행 실패 시엔 본문 dump로 폴백(14-3절). ⚠️ Telegraph 페이지는 URL을 아는
  누구나 볼 수 있는 공개 페이지 — 검수 전 원고 노출 트레이드오프를 사용자가 승인했다.

**남은 것**: 이미지 삽입, SPA 예매 페이지(ticketlink.co.kr 등) 자동 판독은 미해결 —
체크포인트에서 사람이 원본 사이트를 직접 열어보는 것으로 당분간 대체.

## Sprint 3: 검수 게이트 + 이미지 (전 단계 완료)

설계: `docs/ai-handoff/SPRINT_3_DESIGN.md`. 승인된 결정 5건은 §15에, 작업 순서/상태는 §14에 있다.

**구현 완료(커밋 `83542f6`, `f249b66`, `39322c2`, `9e693fe` 외) + 실측 검증(2026-08-28,
"보조금24"/"맥도날드 감튀 홀더" job)**:

1. **검수 규칙 4종** (`src/workflows/review/`) - 팩트/법적/광고/품질. 팩트 검사가 가장 까다로웠다:
   근거의 "2026. 9. 2."와 본문의 "9월 2일"을 같은 값으로 인식하도록 정규화해야 했고, 그래도 못
   맞추는 표기가 남으므로 "틀렸다"가 아니라 **"근거에서 확인되지 않음"**으로만 표기한다. 저장된
   실제 원고 3건에 돌려 캘리브레이션했고, 합성 테스트로는 못 볼 오탐 6가지(URL 인코딩에서 가짜
   백분율, 참고 자료 링크 제목을 우리 표현으로 오인 등)를 찾아 고쳤다 - `normalizeFactTokens.ts`/
   `articleReviewChecks.ts` 상단 주석에 전부 기록돼 있다.
2. **검수 결과가 알림에 표시된다** - `job.metadata.reviewChecks`에 저장(새 테이블 대신, 결정 2번).
   ⚠️ 차단이 아니라 참고다(결정 1번) - 원고는 검수 결과와 무관하게 항상 사람에게 간다.
3. **승인 버튼이 모든 원고 공통이 됐다** - `[✅ 승인][✏️ 수정 필요][🗑 반려]`가 이제 비의학
   원고에도 붙고, 승인(confirm)이 `job.status`/`article.status`를 `approved`로 전이시킨다.
   의학 주제는 승인 시 `requiresMedicalReview`도 함께 내린다. ⚠️ 의미가 바뀐 지점: 이 통합
   이전에 confirm이 눌린 job("아기 셔더링어택")은 `review`에 남아 있어 다시 눌러야 approved가
   된다.
4. **전 구간 실측 검증** - "보조금24" job(지원금 주제, 숫자·날짜 밀도가 높아 팩트 검사 시험에
   적합)으로 조사→버튼→작성→검수(통과)→Telegraph 발행→승인 버튼→`approved` 전이까지 실제로
   확인했다.
5. **이미지 자동 생성 + 본문 삽입** (`SPRINT_3_DESIGN.md` 13-1절, 2026-08-28 재작업) -
   "이미지가 포함된 원고 풀세트가 필요하다"는 피드백으로, 브리프만 만들어 ChatGPT로 넘기던
   방식을 완전 자동화로 바꿨다. 사용자가 `OPENAI_API_KEY`(기본)/`GEMINI_API_KEY`(전환용)를
   직접 제공. `runWritingStage` 안에서 섹션별(도입부+소제목, 2~3장) 장면을 기획하고
   OpenAI `gpt-image-1`로 생성 → Supabase Storage 신규 공개 버킷(`article-images`) 업로드 →
   본문에 마크다운 이미지로 삽입 → Telegraph에 `<figure><img/><figcaption>`으로 렌더링까지
   승인 전에 전부 끝난다. 스타일은 **실사(photorealistic)**로 확정(처음엔 일러스트였다가 사용자
   요청으로 전환) - 얼굴 안 보이는 구도 강제 + 무지 포장/로고 없음 강제로 초상권·상표권 위험을
   프롬프트 단계에서 방어한다. Gemini는 "나노바나나2 라이트"(`gemini-3.1-flash-lite-image`)로
   고정했으나 ⚠️ 무료 티어라 실제 호출은 429로 막혀 있다(유료 결제 필요, 기본 provider는
   openai라 지금은 영향 없음).
6. **이미지 기록** - 자동 생성된 이미지는 `images` 테이블에 자동 기록된다
   (`copyright_status: ai-generated:openai` 형태). **실제 insert로 `images.id`가 identity
   (자동 증가)임을 확인했다** - `types/database.ts`의 미검증 주석을 해소했다. `job:image` CLI
   (`npm run job:image -- <jobId> <imageUrl> <copyrightStatus>`)는 수동 보완 경로로 남아
   있지만, 이미지 직접 교체 기능은 별도 구현하지 않기로 했다 - Sprint 4가 반자동 업로드라
   사용자가 업로드 직전 단계에서 이미 직접 통제할 수 있다(사용자 확인, 2026-08-28).

**실측 검증**: "맥도날드 감튀 홀더" job으로 이미지 3/3장 성공, Telegraph 페이지에 `<img>` 3개
+ `<figcaption>` 3개 정상 렌더링 확인. 실사 스타일도 별도로 생성해 확인(손만 나오고 얼굴 없음,
무지 포장, 로고 없음). "보조금24" job의 `images`에는 초기 검증용 플레이스홀더 URL이 남아
있다(자동화 이전 수동 테스트 흔적) - 실사용 전 정리할 것.

## Sprint 4: 네이버 반자동 발행 (진행 중, 2026-08-28)

설계: `docs/ai-handoff/SPRINT_4_DESIGN.md`. 결정 6건은 §9에, 작업 순서는 §10에 있다.

**완료(§10 item 1-4)**:

1. **실측** - `npm run setup:naver-publish` + `npm run inspect:publish-layer`(신규, "발행"
   버튼을 1회 눌러 설정 패널만 여는 전용 스크립트, 실제 발행 확정 버튼은 절대 클릭하지 않음)로
   실제 로그인 세션에서 SmartEditor DOM을 실측했다. 핵심 발견:
   - `/{blogId}/postwrite?categoryNo={n}`로 **직접** 이동하면 프레임셋을 거치지 않고
     SmartEditor가 최상위 문서로 바로 뜬다(블로그 홈은 frameset이라 자동화에 쓰면 안 됨).
   - 저장/발행 버튼이 3개로 나뉜다 - 툴바 `tpb.save`(임시저장), 툴바 `tpb.publish`(설정
     패널을 여는 버튼, 발행 확정 아님), 패널 안 `tpb*i.publish`/`seOnePublishBtn`(진짜 발행
     확정 - 코드 어디에도 이 셀렉터를 클릭하는 부분이 없다).
   - 태그 입력란(`#tag-input`)은 패널을 열어야만 DOM에 렌더링된다(정적 화면엔 없음).
   - 상세 셀렉터 표는 `SPRINT_4_DESIGN.md` §6-2.
2. **`convertArticleToNaverHtml.ts`** (+ 테스트 8건, `npm run test:naver-html`) -
   `markdownToTelegraphNodes.ts`와 같은 마크다운 부분집합을 SmartEditor 붙여넣기용 HTML
   문자열로 변환. Telegraph 변환기와 달리 Node[] 트리가 아니라 HTML 문자열이 필요한 이유:
   SmartEditor는 API가 없어 브라우저에 paste 이벤트로 넣는 경로만 있다.
3. **`NaverBlogPublisher.ts`** - 제목/본문/이미지/태그를 채우고 "임시저장"만 하는 핵심 클래스
   (`saveDraft()`). ⚠️ **아직 라이브로 끝까지 실행해보지 않았다** - §10 item 7(실측 1건 검증,
   사용자 승인 필요)에서 처음 실제로 돌려본다. 미검증 가설이 여러 개 섞여 있다(파일 상단 주석에
   전부 기록):
   - 제목/본문 입력: SmartEditor는 보이는 `<p>`가 아니라 화면 밖에 숨겨진
     `contenteditable` proxy(IME 처리용으로 추정)가 실제 입력을 받는 구조로 보인다 - "보이는
     영역 클릭 -> 앱이 알아서 그 proxy로 포커스를 옮긴다"는 가정으로 `page.keyboard.type()`/
     paste event를 쓴다.
   - 이미지 업로드: 툴바 버튼 클릭 시 네이티브 파일 선택 대화상자가 뜬다는 가정
     (`page.waitForEvent("filechooser")`).
   - 태그 입력 후 Escape로 패널을 닫아도 입력한 태그가 유지되는지.
   - "임시저장" 성공 신호(토스트/URL 변화 등) - 지금은 저장 버튼 클릭 후 고정 3초 대기 +
     현재 URL을 draftUrl로 반환하는 임시 구현.
   - `saveDraft()`는 이 가설들이 틀리면 어느 stage(login/navigate/title/body/image/tags/save)
     에서 막혔는지를 결과로 알려준다 - 조용히 잘못된 성공을 보고하지 않는다.
   - 카테고리 번호는 실측 세션에서 확인된 32(육아)를 기본값으로 잠정 고정했다 - 내부 category
     (entertainment/ott/parenting/living)별로 다른 네이버 카테고리가 필요한지는 아직 결정된
     바 없다(§10 item 5에서 필요해지면 매핑표를 만든다).
4. **프로필 분리** - `src/config/naverPublish.ts`(Sprint 4 시작 시 이미 작성됨)가
   `.local/naver-publish-profile/`을 Creator Advisor의 `.local/creator-advisor-profile/`과
   분리해 관리한다(둘 다 gitignore).

5. **`publishArticleToNaver.ts` + `job:publish` CLI** - job 상태(`approved`인지) 확인 →
   원고/이미지/해시태그 조립 → `NaverBlogPublisher.saveDraft()` 호출 → `publications`에 기록.
   설계에서 정한 대로 이미지는 본문 paste에 `<img>`로 넣지 않고(`stripImageMarkdownBlocks()`로
   먼저 걷어냄) SmartEditor 툴바 업로드 경로로만 넣는다 - paste와 toolbar 업로드를 동시에 쓰면
   중복 삽입되기 때문이다. **멱등성**: 같은 job으로 두 번 실행해도 `publications`에 이미
   pending/published row가 있으면 재실행하지 않고 기존 기록을 그대로 돌려준다. **실패도
   기록한다** - `NaverBlogPublisher`가 어느 stage(login/title/body/image/tags/save)에서
   실패했는지까지 `publications.status='failed'`와 함께 CLI 출력에 그대로 나온다. 성공 시
   `publications.status`는 `'pending'`으로 남는다(`'published'`가 아니다 - 실제 발행 버튼은
   누르지 않았으므로 "published"라고 부르면 사실과 다르다). 단위 테스트 6건 전부 주입된
   가짜 의존성으로 오케스트레이션 로직만 검증(`npm run test:naver-publish`) - 실제
   Supabase/Playwright는 호출하지 않는다.

6. **`notifyPublishReady.ts`** - 임시저장 성공을 Telegram으로 알린다. `notifyArticleReady.ts`와
   달리 승인/반려 결정 버튼이 없다 - 이 시점의 유일한 다음 행동("네이버 앱에서 직접 발행 버튼
   누르기")은 Telegram 버튼으로 대신할 수 없기 때문이다. 초안 URL을 여는 버튼 하나만 붙이고,
   그 URL이 정확히 저장한 초안을 여는지는 아직 검증 못했다는 문구를 메시지 자체에도 넣었다.
   `job:publish` CLI에 배선 완료. 테스트 5건(`npm run test:notify-publish`).

7. **✅ 완료(2026-08-28)** - "맥도날드 감튀 홀더" job으로 `npm run job:publish -- <jobId>
   --watch`(headless:false로 직접 지켜봄) 실행, 이후 발견된 버그 수정 + 재검증까지 마쳤다.
   상세는 `SPRINT_4_DESIGN.md` §12/§13/§14. 최종 확인된 것:
   - ✅ 제목 입력(숨겨진 contenteditable proxy 가설)
   - ✅ **이미지 toolbar 업로드** (`.se-toolbar-item-image` → filechooser → setInputFiles -
     실제로 NAVER 자체 CDN `blogfiles.pstatic.net`에 재업로드됨, 3장 전부 정상 삽입을 사용자가
     육안 확인) - 가장 불확실했던 부분이라 제일 중요한 확인이었다.
   - ✅ 임시저장 자체("임시저장 글" 목록에 실제로 생김, 시각도 일치)
   - 🐛→✅ **본문 붙여넣기 버그 발견 후 수정·재검증** - 1차 실측 때 실제로는 본문 문단이 통째로
     비어 있었다(제목에 이미 포함된 단어 때문에 자동 검사가 "본문도 있다"고 오판했었다 -
     검증 스크립트의 허점). 원인은 합성 `ClipboardEvent`를 `document.activeElement`에 직접
     dispatch하는 방식을 SmartEditor가 신뢰하지 않아 무시한 것 - 실제 OS 클립보드에 쓰고
     `Ctrl/Cmd+V`를 누르는 방식으로 바꿔서 재검증했고, 사용자가 브라우저를 직접 보며 본문
     문단이 실제로 채워지는 것을 확인했다.
   - ✅→🔄 **해시태그 흐름 변경**: 처음엔 발행 설정 패널(`tpb.publish` 클릭 → `#tag-input`)에
     직접 입력했고 실제로 잘 반영됐지만(사용자 스크린샷 확인), 사용자가 "발행 버튼에 더 가까이
     다가가는 방식이라 위험하다"며 다른 방법을 요청 - 본문 끝에 이미 있는 "#태그" 텍스트가
     paste로 함께 들어가면 네이버가 실제 발행 시점에 자동으로 태그를 인식해 적용해준다는
     사용자 설명에 따라, `NaverBlogPublisher.ts`에서 발행 패널을 아예 열지 않도록 코드를
     단순화했다(`fillTags()`/패널 관련 코드 전부 제거). `saveDraft()` 흐름은 이제
     login → navigate → title → body → image → save로 줄었다 - 자동화가 클릭하는 버튼이
     `tpb.save` 하나뿐이라 실제 발행 버튼과의 거리가 코드상으로도 더 멀어졌다.
   - ⚠️ **별도 발견**: 같은 계정으로 동시에 다른 곳(폰 앱 등)에서 글을 쓰고 있으면 자동화
     세션이 로그아웃될 수 있다 - `job:publish` 실행 전 동시 사용 여부를 먼저 확인하는 게 안전.
   - `save_count_btn__ZTLNa`(`[data-click-area="tpb*s.count"]`, "임시저장된 글 보기") 셀렉터를
     새로 발견 - 저장/발행과 무관한 안전한 조회용 버튼(발행 흐름에는 아직 안 씀).

**Sprint 4 §10 작업 순서 1~7번 전부 완료.** 승인된 원고가 `job:publish` 한 번으로 네이버
블로그 임시저장함에 제목·본문·이미지가 채워진 채로 들어가고(해시태그는 본문 텍스트로 자동
포함), Telegram으로 초안 확인 알림이 온다 - 로드맵의 8단계 파이프라인 중 7단계(발행 직전까지)가
실사용 조건에서 검증까지 마쳤다. 남은 사람 개입은 실제 "발행" 버튼 클릭뿐이다. 테스트용으로
만들어진 초안 2건("맥도날드 감튀 홀더..." 정상본 + "...[재검증]" 본문 검증용)은 실제 배포용이
아니므로 사용자가 초안함에서 정리해도 된다. "임시저장" 성공 신호(토스트/URL 변화)는 여전히
고정 시간 대기로 대체돼 있다 - 급하지 않으면 다음에 개선한다.

## 인프라 정리 (2026-08-28, 중간 점검 후속)

중간 점검에서 나온 "아쉬운 점" 3건 착수. 상세는 `CLOUD_MIGRATION.md` /
`SUPABASE_MIGRATION_SYNC.md`.

1. **클라우드 감시인 (Phase 1 완료)** - `src/jobs/watchdogJob.ts` + `.github/workflows/watchdog.yml`.
   로컬 맥과 다른 호스트(GitHub 러너)에서 매일 11:00 KST에 "오늘 완료된 discovery_run이 있나"를
   확인하고 없으면 Telegram으로 알린다. 강제 종료 시 실패 알림이 안 나가던 구멍을 밖에서 막는다.
   `npm run test:watchdog`(7케이스) + 라이브 dry-run 통과. **가동에는 사용자 개입 2건 필요**:
   repo secret 4개 등록 + 워크플로우 파일 main push. Phase 2(Telegram 수신 분리)/Phase 3(로그인
   세션 이전)는 설계만.

2. **Supabase CLI 도입** - `brew install`로 v2.116.0 설치, `supabase init`로 `config.toml` 생성.
   9개 마이그레이션이 전부 Dashboard 수작업 적용이라 원격 `schema_migrations`가 비어 있는 문제를
   `scripts/supabase-repair.sh`(9개를 `applied` 표시, SQL 실행 안 함)로 해소하는 절차 준비.
   **사용자 개입 필요**: `supabase login` + `supabase link --project-ref <ref>`(DB 비밀번호) 후
   스크립트 실행. 이후 Dashboard 수작업 대신 `supabase db push`(승인 게이트 유지).

3. **git 브랜치 정리** - (병합/push는 사용자 승인 대기 중)

전체 로드맵: `/Users/wooahpapa/.claude/plans/gpt-recursive-squirrel.md`
