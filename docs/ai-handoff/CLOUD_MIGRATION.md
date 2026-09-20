# 클라우드 이전 로드맵

기준일: 2026-09-13

## 2026-09-13 갱신 — 핵심 블로커 두 개 해소 + Phase 2 착수

**배경**: 감시인이 09-09~09-13 계속 실패(마지막 성공 run #41, 09-07)로 관측됨 - 로컬 맥 의존
파이프라인이 실제로 여러 날 멈춰 있었다. 사용자가 "맥 꺼져도 자동으로 도는" 방향을 다시 우선순위로
올림(맥미니는 최후 옵션, 클라우드+무료 우선).

**실측 검증 완료(스모크테스트, `.github/workflows/test-claude-subscription-auth.yml`)** - 아래
"핵심 제약 두 가지" 중 2번(`claude -p` 과금 문제)이 해소됨:

1. `claude setup-token`으로 발급한 구독(Pro/Max) 기반 OAuth 토큰(`CLAUDE_CODE_OAUTH_TOKEN` secret)이
   GitHub Actions 러너에서 `claude -p`를 **API 토큰 과금 없이** 인증함 - 순수 텍스트 응답 확인(1.98초).
2. 같은 토큰으로 WebSearch/WebFetch 도구(리서치 단계와 동일 플래그: `--allowed-tools WebSearch,WebFetch
   --permission-mode acceptEdits`)도 정상 동작 - 실제 검색 실행, 출처 URL 반환 확인(9.7초).
3. 신선한 CI 환경(계정 플러그인 캐시 없음)에서 `claude plugin marketplace add` +
   `claude plugin install moai-marketer@moai-cowork -y`로 계정 플러그인을 즉석 설치 가능,
   Skill 도구(집필 단계와 동일 플래그: `--allowed-tools Read,Write,Skill`)로
   `moai-marketer:content-blog`를 정상 로드함(`LOADED` 응답, 3.6초).

**아직 미확인**: 로컬 인터랙티브 사용과 rate limit을 공유하는지(1회성 테스트로는 판단 불가 - 실사용
중 관찰 필요), 완전 무인 예약 자동화에 대한 Anthropic 이용약관 명문화 여부(문서에서 못 찾음).

**결론**: "1. 로그인 세션에 묶인 것"(Creator Advisor, 네이버 발행)만 여전히 막혀 있고, "2. `claude -p`
과금 문제"는 해소됐다. 아래 원래 로드맵의 Phase 2/3 판단이 이걸 반영해 갱신된다.

**Phase 2 착수(2026-09-13)** - 키워드 수집 3종을 GitHub Actions로 이전:
`.github/workflows/{social-issue,entertainment,community}-keyword.yml` 신규. 로컬과 동일한 npm
스크립트를 그대로 실행(로직 이원화 없음). Creator Advisor는 `CREATOR_ADVISOR_ENABLED=false`로
명시적으로 꺼서 NAVER API+구글트렌드+다음실시간(+커뮤니티는 fetch 기반이라 원래도 로그인 불필요)만으로
수집 - `NON_FATAL_STAGES`(코드로 확인됨)라 꺼도 파이프라인은 정상 완주, 품질만 하락.

신규 repo secret: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`(등록 완료, 2026-09-13).

**지금은 `workflow_dispatch`(수동)만, `schedule` 없음** - 로컬 launchd와 스케줄이 겹치면 같은 시각에
중복 수집 + 중복 텔레그램 알림이 나갈 수 있어, 수동 실행으로 먼저 결과를 검증한 뒤 schedule을 추가하고
그 시점에 로컬 launchd job을 내릴지 결정한다.

**수동 실측 완료(2026-09-13, 같은 세션)** - 세 워크플로우를 실제 순서(사회이슈 → 연예 → 커뮤니티)로
전부 수동 실행, 전부 성공:
- 사회이슈: run #47, 키워드 10건 Telegram 발송(3분22초). 첫 실행에서 rank 단계 주제어 추출이
  `spawn claude ENOENT`로 규칙 기반 폴백된 걸 발견 - `claude` CLI 설치 단계가 이 워크플로우에만
  없었다(community-keyword.yml에는 있었음). 즉시 수정.
- 연예·OTT: run #48, 키워드 10건 발송(2분44초, 재수집 없이 사회이슈가 만든 오늘자 trend_candidates
  재사용 확인). 수정 후 ENOENT 재발 없음.
- 커뮤니티: run #49, 키워드 4건 발송(55초, fetch 기반이라 가장 빠름).

**결론**: 키워드 수집 파이프라인 전체가 맥 없이 GitHub Actions만으로 완주함을 실측 확인. 로컬과
결과 형태(discovery_run 생성, Telegram 알림 형식) 동일.

**Phase 2 전환 완료(2026-09-13, 같은 세션, 사용자 승인)** - schedule 활성화 + 로컬 launchd 이관:
- 세 워크플로우에 cron 추가: 사회이슈 `0 0 * * *`(00:00 UTC=09:00 KST), 연예·OTT `10 0 * * *`
  (00:10 UTC=09:10 KST), 커뮤니티 `0 4 * * *`(04:00 UTC=13:00 KST). `workflow_dispatch`는
  유지(수동 재실행용).
- 로컬 launchd 3개(`social-issue-keyword`/`entertainment-keyword`/`community-keyword` plist)는
  `launchctl bootout`으로 내림. plist 파일은 삭제하지 않음 - 되돌리려면
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<plist>`.
- `telegram-poll`/`publish-poll`은 이번 범위 밖 - 로컬에 그대로 남아 있고 여전히 맥 의존.

**지금부터 키워드 수집 3종의 유일한 실행 경로는 GitHub Actions다.** 다음 확인: 내일(2026-09-14)
09:00/09:10/13:00 KST 자동 실행이 정시에 도는지 관찰(Actions 탭 또는 텔레그램 도착 시각으로 확인).

**남은 로컬 의존 구간**(맥이 꺼지면 여전히 멈추는 것): 텔레그램 버튼 수신(`telegram-poll`),
리서치/집필/발행 폴링(`publish-poll`) - 이게 다음 Phase 대상.

## Phase 3 완료(2026-09-14, 같은 세션) — 텔레그램 버튼 수신을 클라우드로

**설계**: 폴링을 웹훅으로 바꾸되 비즈니스 로직은 재구현하지 않는다.

```
텔레그램 버튼 클릭
  → Cloudflare Worker(cloudflare/telegram-relay/, secret_token 검증만, 로직 없음)
  → GitHub repository_dispatch(telegram_update 이벤트, update JSON을 client_payload로 그대로)
  → telegram-update.yml → job:telegram-update(runTelegramUpdateCli.ts)
      → TelegramBot.processUpdate() 재사용(pollOnce()에서 순수 추출, 동작 무변경)
      → 무거운 작업(리서치/집필)은 triggerResearch/triggerWriting을 GitHub workflow_dispatch
        API 호출로 오버라이드 -> job-research.yml / job-write.yml을 별도 워크플로우로 새로 발화
```

**왜 detached 프로세스를 못 쓰는가**: GH Actions 러너는 job이 끝나면 통째로 내려가서, 그 안에서
띄운 백그라운드 자식 프로세스가 완료 전에 같이 죽는다(로컬 launchd와 결정적으로 다른 점) - 그래서
"같은 러너에서 fire-and-forget"이 아니라 "별도 워크플로우 실행을 API로 새로 만드는" 방식을 썼다.

**구현**: `TelegramBot.ts`에 `processUpdate()` 신설(리팩터링만, `test:telegram-bot` 전체 통과 확인) +
`src/services/github/dispatchWorkflow.ts` + `src/jobs/runTelegramUpdateCli.ts` +
`.github/workflows/{job-research,job-write,telegram-update}.yml` + `cloudflare/telegram-relay/`.

**설정(사용자 작업)**: GitHub fine-grained PAT(저장소 단일 범위, Contents: Read and write) 발급 →
Cloudflare Workers용 API 토큰 신규 발급("Cloudflare Workers 편집" 템플릿, 기존 Pages 토큰은
Workers 권한이 없어서 재사용 불가 확인됨) → workers.dev 서브도메인 최초 등록(`<계정>.workers.dev`)
→ Worker 배포(`wrangler deploy`) → Worker secret 2개 등록(`TELEGRAM_WEBHOOK_SECRET`은 Claude가
생성, `GH_DISPATCH_TOKEN`은 PAT를 사용자가 직접 `wrangler secret put`).

**검증(실제 컷오버 전)**: 가짜 텔레그램 페이로드로 curl 3종 테스트 - 잘못된 secret_token(403),
callback_query 없는 update(200, GitHub 안 깨움), 가짜 callback_query·다른 chat_id(200 + 실제
GitHub Actions 실행 + chat_id 검증으로 안전하게 ignored 처리, DB/텔레그램 무변경) - 전부 통과.

**컷오버**: `setWebhook` 호출(Worker URL + secret_token) → `getWebhookInfo`로 등록 확인 →
`launchctl bootout`으로 로컬 `telegram-poll` 내림.

**실제 클릭 검증 - 전 구간 완주(2026-09-14)**:
- "Go" 클릭 → `telegram-update`(32초, job 생성+제목 생성+리서치 트리거) → `job-research.yml`
  자동 실행 → **9분 6초, verdict `ok`로 완료**, 텔레그램에 리서치 요약 + [✍️ 원고 작성] 버튼 도착.
- "원고 작성" 클릭 → `telegram-update`(19초, `research:write` 처리) → `job-write.yml` 자동 실행
  → **완료**(job `0d7f7939-...`, 상태 `검수 대기`로 정상 전이 확인 - `npm run report:jobs`로 검증).
- **버그 발견 + 수정**: 첫 `job-write.yml` 실행이 18분 41초나 걸림(보통 훨씬 빠름) - 원인은
  `job-research.yml`에는 있던 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`을 `job-write.yml`에 빠뜨려서,
  검수 단계 NAVER 기준 출처 수집이 전부 실패 -> 에이전트가 전부 재조사하는 폴백 경로를 탐 - 치명적은
  아니었지만(자동 폴백으로 완료는 됨) 품질/속도 저하. 즉시 추가해 수정.

**지금부터 키워드 수집 + 텔레그램 버튼 수신 + 리서치/집필 트리거까지 전 구간이 맥 전원과 무관하게
클라우드에서 실측 완주 확인됨.** 로컬에 남은 건 `publish-poll`(원고 페이지 준비 + Cloudflare Pages
배포 트리거) 하나 - 다음 Phase 대상.

## Phase 4 완료(2026-09-14, 같은 세션) — 발행 준비(publish-poll)를 이벤트 기반으로

**설계**: Phase 3와 같은 원칙 - 폴링 대신 이벤트. `review:confirm`(✅ 승인) 콜백이 성공하는 바로
그 순간(`TelegramBot.ts` confirm 분기 끝)에 `triggerPublishPrepare()`를 호출해
`job-publish-prepare.yml`을 바로 발화한다. 10분 주기 cron이었다면 대기열이 매번 비어 있어도
하루 144회 GH Actions 분을 태웠을 것 - 승인은 텔레그램 버튼을 눌러야만 일어나는 사건이라 이벤트로
묶는 게 더 정확하고 싸다. `job-publish-prepare.yml`은 기존 `job:publish-poll` 스크립트를 그대로
재사용(`prepareApprovedManuscripts` + Cloudflare Pages 배포, 코드 변경 없음).

**신규 GitHub secret 3종**: `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/
`CLOUDFLARE_PAGES_PROJECT_NAME`(Pages 배포용 - Phase 3의 Workers 전용 토큰과는 다른 토큰).

**검증 중 발견한 운영 사고(코드 버그 아님) - 중요**: 검증하다가 타임스탬프가 안 맞는 걸 발견해서
추적한 결과, **로컬 맥의 `publish-poll`이 이번 세션 내내 한 번도 안 꺼진 채 계속 10분 주기로 돌고
있었다** - Phase 3에서 `telegram-poll`만 내리고 `publish-poll`은 깜빡했다. 그래서 사용자가 처음
승인 버튼을 누른 시점(Phase 4 코드 push 전)에 로컬 폴러가 먼저 job을 처리해버렸고, 이후 코드
배포 후 다시 누른 승인은 클라우드로 정확히 갔지만 "이미 처리됨"이라 빈 대기열로 빨리 끝났다 -
**이벤트 배선 자체는 정상 동작 확인**(dispatch 성공, 워크플로우 정상 실행), 다만 로컬이 먼저
채간 것뿐.

**더 중요한 발견**: 이 참에 확인해보니 Phase 2에서 내렸던 키워드 수집 3개 launchd job도
`launchctl bootout`만 했지 `disable`은 안 했었다 - bootout은 일시 해제일 뿐이라 맥 재부팅/재로그인
시 `RunAtLoad: true`로 다시 살아난다(오늘 아침 텔레그램 폴러 409 에러가 정확히 이 패턴으로
재발했던 것과 동일한 원인). **로컬 blog-automation launchd 5개 전부(`telegram-poll`,
`publish-poll`, `social-issue-keyword`, `entertainment-keyword`, `community-keyword`) 이번에
`launchctl disable` + plist를 `.disabled`로 이름 변경까지 해서 재부팅에도 안전하게 완전히
껐다.** 복구하려면 `.disabled` 접미사를 떼고 `launchctl enable` + `launchctl bootstrap`.

**클라우드 이전 최종 상태**: `~/Library/LaunchAgents/`에 blog-automation 관련 활성 plist 0개.
전체 파이프라인(키워드 수집 → 텔레그램 → 리서치 → 집필 → 승인 → 발행 준비 → Cloudflare Pages
배포)이 맥 전원과 완전히 무관하게 클라우드에서 돈다.

---

기준일(이전): 2026-08-28

## 왜 이 문서가 있나

지금 시스템은 **전부 이 맥 한 대에 묶여 있다.**

- `launchd`가 매일 09:00에 `job:daily-keyword`를, 5분마다 `job:telegram-poll`을 띄운다.
- 맥이 꺼져 있거나 잠들면 실행되지 않는다.
- 더 나쁜 건, **강제 종료된 프로세스는 실패 알림을 보낼 수 없다**는 점이다
  (`notifyPipelineFailure`는 예외를 잡아서 보내는 구조라 프로세스가 통째로 사라지면 침묵한다).
  2026-08-27에 실제로 이 일이 있었다 - CURRENT_STATE.md "운영 노트: 잠자기로 인한 조용한 실패".

`caffeinate -i` + `pmset repeat wakeorpoweron`으로 완화했지만 전원 차단·강제 재부팅·launchd
미발화는 여전히 남는다. 근본 해결은 **감시와 트리거를 다른 호스트로 빼는 것**이다.

로드맵(§8)은 이미 "클라우드 이전이 목적이면 n8n보다 GitHub Actions"라고 결론냈다. 이 저장소는
전부 `npm run ...` 스크립트라 GitHub Actions에 그대로 얹힌다.

## 무엇을 옮길 수 있고 무엇이 막혀 있나

| 작업 | 클라우드 이전 | 막는 것 |
|---|---|---|
| **감시인** ("오늘 성공 run 있나?") | ✅ 즉시 가능 | 없음 - Supabase 읽기 + Telegram 발송뿐 |
| 키워드 수집 `job:daily-keyword` | ⚠️ 부분 | `trendCollect` 단계가 **로그인된 Creator Advisor 브라우저 프로필**에 묶여 있음. 이 단계는 비치명적이라 빼고 돌릴 수는 있으나(트렌드 후보 없이 seed만) 품질이 떨어진다 |
| Telegram 수신 `job:telegram-poll` | ⚠️ 큰 작업 | 제목 생성·원고 작성이 `claude -p`(헤드리스 Claude CLI) + moai-* 스킬에 의존. CI에서 돌리려면 `@anthropic-ai/claude-code` 설치 + `ANTHROPIC_API_KEY`(= 새 API 과금) + 스킬 이식이 필요 |
| 네이버 발행 `job:publish` | ❌ | 로그인된 `.local/naver-publish-profile/` 필수. 계정 세션을 CI로 못 옮긴다 |

핵심 제약 두 가지:

1. **로그인 세션에 묶인 것은 못 옮긴다** - Creator Advisor 크롤링, 네이버 발행.
   이건 셀프호스트 러너(집에 있는 다른 always-on 기기)나 클라우드 브라우저 세션을 두기 전엔 안 된다.
2. **`claude -p`에 묶인 것은 과금 결정이 필요하다** - 지금은 Claude 구독을 CLI로 쓰지만 CI에선
   API 키가 있어야 하고, 그건 토큰당 과금이다(로드맵 §6-8 미해결 항목).

## 단계별 계획

### Phase 1 — 감시인 (완료, 2026-08-28)

`.github/workflows/watchdog.yml` + `src/jobs/watchdogJob.ts` + `npm run job:watchdog`.

매일 02:00 UTC(11:00 KST)에 GitHub 러너가 `discovery_runs`에서 오늘 완료된 run을 찾고,
없으면 Telegram으로 알린다. 로컬 맥과 완전히 독립적이다.

- 판정 로직은 순수 함수로 분리(`evaluateWatchdog`) - `npm run test:watchdog`로 검증.
- 감시인이 문제를 찾으면 워크플로우도 빨갛게 실패한다(GitHub 알림으로 이중 통지).
- **남은 준비**: repo secret 4개 등록 + 워크플로우 파일 push. §"사용자 개입 필요" 참고.

이 단계만으로 "조용한 실패"의 관측 구멍은 닫힌다. 나머지는 자동화 범위를 넓히는 것이지
안전을 위한 필수는 아니다.

### Phase 2 — Telegram 수신을 둘로 쪼갠다 (설계만, 미착수)

현재 `pollOnce()`가 콜백 하나를 받아 그 자리에서 제목 생성·원고 작성까지 동기로 끝낸다.
가벼운 부분과 무거운 부분을 분리한다:

- **가벼움 (클라우드로)**: 콜백 파싱 → `article_jobs` 상태 전이(selected/rejected/passed),
  의학 교차확인, 조사 후 중단. Supabase 쓰기뿐이라 CI에서 1분 안에 끝난다.
  GitHub Actions cron을 5~10분으로 돌리면 "버튼 눌러도 최대 5분" 지연은 그대로지만
  맥이 꺼져 있어도 선택은 기록된다.
- **무거움 (로컬 유지)**: 제목 생성(`claude -p` 90초), 원고 작성(`runWritingStage` 수 분 +
  OpenAI 이미지). 로컬 맥이 `article_jobs`에서 `selected`인데 제목이 없는 job,
  `write_requested` 플래그가 선 job을 폴링해 처리한다.

필요한 신규 작업:
- `article_jobs`에 "작성 요청됨"을 나타내는 상태나 metadata 플래그(지금은 버튼 클릭이 곧바로
  실행이라 이 중간 상태가 없다).
- 로컬 쪽 "미처리 job 처리" 워커(`job:process-pending` 같은 것).
- `TelegramBot.pollOnce()`를 "상태 전이만" 모드와 "전체" 모드로 가르기.

이건 아키텍처 변경이라 별도 스프린트 분량이다. Phase 1 감시인이 안정적으로 도는 걸 며칠 본 뒤 착수.

### Phase 3 — 로그인 세션 의존 제거 (미착수, 어려움)

Creator Advisor 크롤링과 네이버 발행을 클라우드로 옮기려면:

- **옵션 A**: 집에 always-on 미니 PC/라즈베리파이를 두고 GitHub Actions self-hosted runner로 등록.
  로그인 프로필을 그 기기에 두면 클라우드 러너처럼 쓰되 세션은 유지된다. 맥 의존만 제거.
- **옵션 B**: 클라우드 VM(상시 실행) + 원격 데스크톱으로 최초 로그인. 비용이 든다.
- **옵션 C**: Creator Advisor는 포기하고 seed query만으로 운영. 트렌드 반영이 약해지지만
  가장 단순하다.

지금 결정하지 않는다. Phase 1·2로 "안전"과 "선택 기록"은 확보되므로, Phase 3는 자동화 욕심의
영역이고 비용/기기 투자 판단이 필요하다.

## 사용자 개입 필요 (Phase 1 가동)

1. **GitHub repo secret 4개 등록**
   `github.com/Jayden-2028/blog-automation` → Settings → Secrets and variables → Actions →
   New repository secret. `.env`의 값을 그대로:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   (Claude가 `gh secret set`으로 대신 넣을 수도 있으나, service_role 키를 제3자 서비스에 올리는
   일이라 사용자가 직접 하는 편이 낫다. 원하면 Claude가 실행한다 - 승인만 주면 된다.)

2. **워크플로우 파일 push** - `.github/workflows/watchdog.yml`이 main에 올라가야 스케줄이 활성화된다
   (git 정리 계획의 일부).

3. **첫 수동 실행으로 검증** - push 후 Actions 탭 → keyword-collection-watchdog → Run workflow.
   오늘 run이 있으면 green, 없으면 Telegram 알림 + red. 한 번은 눈으로 확인.

## 검증 명령 (로컬)

```bash
npm run test:watchdog              # 판정 로직 7케이스
npm run job:watchdog -- --dry-run  # 실제 Supabase 읽기, 발송은 안 함
SEND=1 npm run test:watchdog       # 실제 Telegram으로 stale 알림 1건 발송(경로 확인용)
```
