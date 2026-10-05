# 개편2 — 사회 이슈 트랙 분리 (2026-10-05, 설계서 `RESTRUCTURE-PLAN-2026-10.md` §3)

브랜치 `feat/restructure-2-social-track` (개편1이 main에 들어간 `41f529d` 위에서 시작). **멀티봇 레이어는 개편3(사용설명서)이 그대로 쓴다 - track 일반화로 구현.**

## 한눈에

| 구성 | 위치 |
|---|---|
| 트랙 표(엔터/사회/사용설명서) · 봇 토큰·채팅 ID 해석 · `job.metadata.track` | `src/notifications/telegramTracks.ts` |
| 발송: `TelegramNotifier.fromEnv(track)` · 수신: `TelegramBot.fromEnv(opts, track)` | `src/notifications/` |
| job을 다루는 알림의 봇 선택 | `src/notifications/notifierForJob.ts` (`notifierForJob(job)` / `notifierForJobId`) |
| Worker 경로 라우팅 `/webhook/<track>` + dispatch payload `track` | `cloudflare/telegram-relay/src/{index,track}.ts` |
| 러너가 update의 track으로 봇 생성 | `src/jobs/runTelegramUpdateCli.ts` |
| 20:00 데일리 리포트(섹션별 목록 + Go/Pass) | `src/jobs/socialIssueKeywordJob.ts`, `src/config/socialReportSections.ts` |
| 경제·정책 어휘(living 편입) | `src/config/keywordCategoryRules.ts` (`SOCIAL_POLICY_TERMS`/`SOCIAL_ECONOMY_TERMS`) |
| 사회용 원고 완료 알림(🟠 티스토리 발행 버튼만, 2026-10-06 자동 발행 재개) | `src/workflows/manuscripts/notifyManuscriptsReady.ts` |
| 사회 전용 뷰어 `social.html` | `src/config/manuscriptViewerPages.ts`, `writeManuscriptPages.ts`, `renderManuscriptPage.ts` |

## 설계 결정

- **track은 DB 컬럼이 아니라 jsonb에 둔다.** `article_jobs.metadata.track`, `manuscript_manifest_topics.channels[0].track`. 컬럼을 추가하면 migration(승인 게이트)이 필요하다. **값이 없으면 엔터**라 개편 전 행은 전부 그대로 엔터로 읽힌다. 엔터는 값을 새기지 않는다.
- **봇 선택은 두 갈래.** 수신(버튼 클릭)은 Worker가 webhook 경로로 정한 `track`을 dispatch payload에 싣고, 발송(조사·집필·승인 알림)은 `job.metadata.track`을 본다. Go 버튼을 받은 봇이 만든 job에 그 봇의 track이 새겨지므로 이후 알림은 같은 봇으로 이어진다.
- **다른 트랙으로 대신 보내지 않는다.** 사회 봇 토큰이 없으면 메인봇으로 보내지 않고 던진다(오배송 방지). Worker도 같다 - 토큰이 없으면 토스트만 생략한다.
- **본문의 `track`은 신뢰하지 않는다.** Worker가 경로로 정한 값이 update 본문의 같은 이름 필드를 덮어쓴다.
- **루트 경로(`/`)는 엔터.** 개편 전 메인봇 webhook이 Worker 루트를 가리키므로 재등록이 필요 없다.
- **사회 리포트는 커뮤니티를 다시 크롤링하지 않는다**(`communityOptions.enabled=false`). 엔터 회차 3번이 낮 동안 채워 둔 `trend_candidates`를 읽어 category `incident/living/community`만 수거한다. 크롤링 부하를 더하지 않는다(§2.4).
- **뷰어는 같은 Pages 프로젝트의 경로 분리 페이지.** 엔터 `index.html`(기존 그대로), 사회 `social.html`. 사회 원고가 있을 때만 `social.html`을 쓴다. Access 게이트는 프로젝트 단위라 그대로 상속된다.

## 검증 (로컬, 네트워크·운영 DB 없음)

`npm run build` 통과. 새 테스트: `test:telegram-tracks` · `test:relay-track` · `test:relay-fetch`(Worker 경로·토큰·payload) · `test:social-report` · `test:manuscript-track-pages`, 확장: `testNotifyManuscriptsReady`.
기존 회귀(`test:keyword-category` · `test:format-notification-message` · `test:prepare-manuscripts` · `test:viewer-*` · `test:relay-schedule` · `test:watchdog` · `test:notify-multi-publish` 등) 통과.
`test:notification` · `test:manuscript-manifest` · `test:telegram-bot`의 일부 단계는 실제 Supabase가 있어야 해서 더미 env로는 못 돈다(코드 변경과 무관).

## 아직 안 한 것 = 승인·사용자 작업이 필요한 것 (순서대로)

완료 기준(§6 10/8~10/10: 봇 B 왕복, 20:00 리포트 수신 → Go → 원고 1건, 뷰어 복사 → 티스토리 리허설)은 **실운영 확인**이라 아래가 끝나야 닫힌다.

1. **GitHub secrets 4개**: `SOCIAL_TELEGRAM_BOT_TOKEN` · `SOCIAL_TELEGRAM_CHAT_ID`(+ 개편3용 `KSCENE_*` 2개). 값은 `prod/.env`에 이미 있다. 워크플로 6개가 이 이름으로 읽도록 바꿔 놨다 - 값이 없으면 사회 알림이 실패한다.
2. **main 병합 → Worker 배포**: `cd cloudflare/telegram-relay && npx wrangler deploy`. 먼저 `--dry-run`으로 번들 확인.
3. **Worker secret**: `echo -n "<사회 봇 토큰>" | npx wrangler secret put SOCIAL_TELEGRAM_BOT_TOKEN` (파이프 필수 - wrangler.toml 주석의 09-16 사고).
4. **사회 봇 webhook 등록**(외부 설정 변경): 메인봇과 같은 `secret_token`·`allowed_updates`로 `https://<worker>/webhook/social`을 `setWebhook`. 메인봇은 건드리지 않는다.
5. **Pages 재배포**: `npm run manuscripts:build -- --refresh` (사회 원고가 생긴 뒤 `social.html`이 올라간다).
6. 확인: 사회 봇에 테스트 메시지·버튼 왕복 → 20:00 리포트 → Go → 원고 → 알림에 🟠 티스토리 발행 버튼만 있는지(네이버·블로그스팟 버튼 없음) → 버튼 → 맥미니 폴러가 비공개로 티스토리 발행.

## 알려 둔 한계

- 맥 폴러가 보내는 "내려받기 완료"(`manuscriptExportPollJob`)·네이버 발행 결과는 맥미니 소유 세션 영역이라 건드리지 않았다. 알림은 메인봇으로 간다(같은 개인 채팅이라 사용자는 받는다).
- 티스토리 발행 여부 추적(선택 항목 §3.3)은 1차 범위에서 제외했다.
- 사회 리포트의 섹션 분류는 어휘 기반 표시용이다. category(집필 스킬 선택)는 바꾸지 않았다.
- `notifyPipelineFailure`·watchdog 알림은 메인봇으로 간다(운영 알림은 한 곳에 모은다).
