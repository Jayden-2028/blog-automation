# 클라우드 이전 로드맵

기준일: 2026-08-28

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
