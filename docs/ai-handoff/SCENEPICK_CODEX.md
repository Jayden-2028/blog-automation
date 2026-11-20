# scenepick 트랙 - 맥미니 Codex 발주 (2026-11-21)

## 결정 (사용자, 2026-11-21)

1. **티스토리 운영 중단**(블로그는 남긴다). 사회 트랙 키워드 수집과 그 경보도 멈춘다. 코드는 지우지 않고 **꺼 두기만** 했다.
2. 새 네이버 블로그 **scenepick**(https://blog.naver.com/scenepick- , "몽상가N의 쓸데없는 궁금증들" - 궁금증·설명형 글).
   **수동 발행뿐**이다 - 사용자가 뷰어에서 본문을 복사하고 이미지를 받아 직접 올린다(엔터 네이버와 같은 방식).
3. 원고는 **맥미니 Codex(ChatGPT 구독 Codex CLI)** 가 조사·집필·**이미지 생성까지 직접** 한다. 우리 코드는 **형식만** 검사하고
   뷰어(`scenepick.html`)에 올린 뒤 사회 봇으로 알린다. 우리 researcher/writer(job-research/job-write)는 이 트랙에 쓰지 않는다.
4. 사회 봇에 보낸 **답장이 아닌 일반 글자 메시지 = 새 주제**, 받는 즉시 발주. 답장은 기존 의미(원고 수정 피드백) 그대로다.
   카테고리는 Codex가 다섯 중 하나를 고르고 뷰어에 보인다: 알아두면 쓸모있을 / 일상 속 과학 / 세상의 별별 이야기 / 잡다구리 노트 / AI시대 살아남기.
   옛 `social.html`은 보관용으로 남고 티스토리 발행 버튼만 숨겼다.

## 흐름

```
사용자 ──(일반 메시지)──▶ 사회 봇 webhook /webhook/social (Cloudflare Worker)
        Worker: forwardsPlainMessages(social)=true -> repository_dispatch(track=social)
                                   │
                                   ▼
GitHub Actions telegram-update.yml -> runTelegramUpdateCli
        track=social && 글자 메시지 && 답장 아님 && "/" 아님 && SOCIAL_TELEGRAM_CHAT_ID 채팅
        -> handleScenepickTopic: article_jobs 1건 생성(createManual), 메시지 번호로 중복 방지
           metadata = { track:"scenepick", source:"scenepick_input", inputTopic(≤4KB), scenepickMessageId,
                        scenepickCodex:{ status:"requested", requestedAt, attempts:0 } }
        -> 사회 봇 답장 "📝 접수했습니다: <keyword> …"         (triggerResearch는 부르지 않는다)
        (그 밖의 update - 답장·버튼·명령 - 는 TelegramBot.processUpdate로 그대로)
                                   │
                                   ▼  (2분마다)
맥미니 launchd com.blogautomation.scenepick-poll -> scripts/macmini/poll-scenepick.sh -> npm run job:scenepick-poll
        1) 가장 오래된 requested 1건 claim (running 60분 무소식 = 잔재 -> 1회 재집기, 2회째면 실패로 닫음)
        2) 작업장 $SCENEPICK_WORKSPACE(기본 ~/blog-automation/scenepick-workspace)
           - 저장소 codex/scenepick/AGENTS.md -> 작업장 루트 AGENTS.md 로 매번 복사(없으면 job 실패)
           - 납품 폴더 jobs/<jobId>/ 생성. package/(사용자 문체 패키지)·기타 파일은 절대 지우거나 덮지 않는다
        3) codex exec --sandbox workspace-write --cd <작업장> --skip-git-repo-check -c tools.web_search=true -
           (주문서는 stdin, 상한 40분. 주문서 = src/workflows/scenepick/scenepickPrompt.ts)
        4) 형식 검사(validateScenepickDelivery) - 실패하면 같은 폴더로 재작업 주문 1회("이 항목만 고쳐서 다시 납품")
        5) 통과: 이미지 업로드(article-images/<jobId>/<index>.webp) -> manifest **이 원고 한 행만** saveManifest
           -> metadata.channelManuscriptsReadyAt -> status=approved -> scenepickCodex.done
           -> manuscripts-refresh.yml 발화(GITHUB_TOKEN 있을 때) -> 사회 봇 "✅ 원고 준비 완료 — <제목> …" + scenepick.html#jobId
        6) 실패: scenepickCodex.failed + error, status=rejected + rejectedAt, 사회 봇 "⚠️ 원고 발주 실패 — …"
           로그인 만료면 원인이 "맥미니 codex 로그인 필요"(재시도 없이 즉시)
```

## 상태 (`job.metadata.scenepickCodex`)

| status | 뜻 | job.status |
|---|---|---|
| `requested` | 접수됨, 맥미니 대기 | `selected` |
| `running` | 폴러가 집음. `heartbeatAt`은 Codex 회차를 시작할 때마다 갱신 | `selected` |
| `done` | 뷰어에 올라감. `title`·`category`·`imageCount`·`durationSec`·`tokensUsed`·`finishedAt` | `approved` (+`channelManuscriptsReadyAt`) |
| `failed` | `error`·`failures`(마지막 형식 검사 항목)·`finishedAt` | `rejected` (+`rejectedAt`) |

그 밖의 키: `attempts`(Codex 호출 수, 상한 2 = 첫 발주 + 재작업), `claims`(폴러가 집은 수, 상한 2), `claimId`, `startedAt`.

## 납품 규격 (우리 검사 = `src/workflows/scenepick/validateScenepickDelivery.ts`, AGENTS.md와 같아야 한다)

- `jobs/<jobId>/manuscript.md`: 본문 Markdown, `## ` 소제목, 이미지 자리는 한 줄 전체 `[IMAGE: 설명]`, H1 없음(있으면 버린다).
- `jobs/<jobId>/meta.json`: `title`, `category`(다섯 중 하나), `tags`(# 제거·중복 제거·10개까지), `summary`(160자로 자름),
  `images[{index,file,description,alt?,caption?,method?,prompt?}]`, `sources[{title,url,publishedAt?,checkedAt?}]`.
- 실패 조건(전부 재작업 주문에 문장 그대로 실린다): JSON 안 읽힘 / 제목 없음 / 카테고리 이탈 / 본문 1,200자 미만(마커 제외·공백 제외) /
  `[IMAGE:` 수 ≠ images 수 / 문장 속 마커 / index가 1..n이 아님 / 파일 없음·10KB 이하·PNG/JPEG/WEBP 아님 / 폴더 밖 경로 / 이미지 0장.
- **하한은 깨진 납품을 잡는 바닥일 뿐**이다(AGENTS.md의 목표는 이미지 4~8장(기본 5), 2,500~6,000자 - Codex 몫).
- **모르는 필드·여분 파일로는 실패하지 않는다**(sources.json·review.md·offline.html·delivery.json·images/src/*.svg). 이미지는 meta가 가리키는 것만 센다.

뷰어 반영 규칙(`buildScenepickEntry.ts`): `## X` → `**X**` + 다음 문단을 바로 붙임(파이프라인 관례), `alt ?? description` → 이미지 description(뷰어 alt·캡션),
`caption` → 이미지 아래 한 줄(`ManuscriptImage.caption`), `prompt` → 이미지 프롬프트, `method` → provider(`codex-ai`/`codex-diagram`, 도해는 업로드 화질 0.9),
`sources` → 본문 밖 "출처" 접이식 칸(`ManuscriptEntry.sources` - **복사 대상이 아니다**), manifest topic.category = 블로그 카테고리.

## 다른 파이프라인이 이 job을 집지 않게 한 선택 (브리프 C)

전 선택기를 status 기준으로 훑었다. 결론: **새 status를 만들지 않고, 자연히 빠지는 흐름**을 골랐다.

- 접수 = `selected`: `selected`를 **자동으로** 집는 곳은 `listPersonJobsNeedingSourcePack`(category=person만)뿐이다. 조사·집필은 status 폴링이
  아니라 `triggerResearch`(dispatchResearch)·heavy-pipeline 큐로만 시작되는데 **접수에서 부르지 않는다**. research-poll은
  `metadata.localResearch`, gemini 그림자는 category=person, kscene 수집은 track=kscene만 본다. `runArticleJobCli`(수동 CLI)는 목록만 보여 준다.
- 완료 = `approved` + `channelManuscriptsReadyAt`: 원고 준비(`listApprovedWithoutManuscript`)는 준비 시각이 **없는** 것만 집는다. 그래서
  **준비 시각을 먼저 적고 status를 나중에** 바꾼다(반대 순서면 그 틈에 job-publish-prepare가 집어 우리 writer 경로를 탈 수 있다).
  `publishApprovedArticles`(폴링 자동 발행)는 호출되지 않는 코드이고, 발행 진입점들은 `isManualPublishOnly`(scenepick 추가)와
  `TRACK_ALLOWED_CHANNELS.scenepick = []`로 이중으로 막힌다. style-learn은 articles 테이블을 읽는데 scenepick은 articles 행이 없다.
- 실패 = `rejected` + `rejectedAt`: 끝난 job이다. storage-cleanup이 반려 job의 이미지를 정리할 수 있다(실패 job은 업로드 전에 멈추므로 보통 비어 있다).
- watchdog은 article_jobs를 보지 않는다(discovery_runs만). 사회 수집 감시(`social_issue`)는 이번에 뺐다.
- 알려진 한계: scenepick은 articles 행이 없어서 뷰어의 **💾 수정본 저장은 동작하지 않는다**(수정은 복사에만 적용 - 페이지 안내 문구에 적었다).
  scenepick 알림에 **답장해도 아무 일도 없다**(수정 피드백 매칭 키 `editRequestMessageId`를 남기지 않는다 - 재작업은 새 메시지로 다시 보낸다).

## 끈 것 (A)

- Worker `schedule.ts`: `KEYWORD_BY_UTC_HOUR[11]` = `[]`(키를 지우면 "모르는 시각" 오류 로그가 매일 남는다), 00:30 UTC 슬롯에서
  `tistory-inventory.yml`만 뺐다(analytics-search·kscene-image-health 유지). cron 문자열·wrangler.toml 불변.
- `watchdogJob.ts` WATCHED_JOBS에서 `social_issue` 제거.
- 사회 발행 버튼: `TRACK_PUBLISH_CHANNELS.social = []`, `TRACK_ALLOWED_CHANNELS.social = []`(옛 알림의 🟠 버튼도 거절 안내),
  뷰어 `PUBLISH_BUTTONS.social` 제거(스펙은 `SOCIAL_TISTORY_BUTTON`으로 보존), 사회 알림 키보드에서도 빠짐.
- 되살리기: 위 각 자리의 주석에 한 줄 복원 방법을 적어 두었다.

## 리드가 할 일 (승인 필요 항목)

1. **병합 후 Worker 재배포**(사회 봇 일반 메시지 전달 + 스케줄 변경):
   `cd cloudflare/telegram-relay && npx wrangler deploy --dry-run && npx wrangler deploy`
   (새 webhook·setWebhook은 필요 없다 - scenepick은 /webhook/social로 들어온다.)
2. **맥미니**(ssh wooahpapa@wooahpapaui-macmini.local, 저장소 경로는 운영 중인 checkout):
   ```
   cd <맥미니 저장소> && git pull
   # 티스토리 폴러 내리기(목록에 남겨 둔 이유: 빼면 이 명령이 이름을 못 찾는다. 전체 install은 다시 켜므로 쓰지 말 것)
   scripts/macmini/install-launchd.sh uninstall tistory-poll
   # 작업장(저장소 밖). package/는 사용자 문체 패키지 자리 - 폴러는 건드리지 않는다
   mkdir -p ~/blog-automation/scenepick-workspace/package ~/blog-automation/scenepick-workspace/jobs
   # codex 확인(구독 로그인)
   which codex && codex login status
   # 수동 시험 1건(텔레그램으로 주제를 하나 보낸 뒤 jobId로)
   npm run job:scenepick-poll -- <jobId>
   # launchd 등록
   sed -e "s|REPO_PATH|$PWD|g" -e "s|HOME_PATH|$HOME|g" \
     scripts/macmini/com.blogautomation.scenepick-poll.plist.template \
     > ~/Library/LaunchAgents/com.blogautomation.scenepick-poll.plist
   launchctl enable gui/$(id -u)/com.blogautomation.scenepick-poll
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.blogautomation.scenepick-poll.plist
   ```
   해제: `launchctl bootout gui/$(id -u)/com.blogautomation.scenepick-poll`. 로그: `~/Library/Logs/blog-automation-scenepick.log`.
   맥미니 `.env`에 필요한 것(기존 폴러와 같다): SUPABASE 키, `SOCIAL_TELEGRAM_BOT_TOKEN`·`SOCIAL_TELEGRAM_CHAT_ID`,
   `GITHUB_TOKEN`·`GITHUB_REPOSITORY`(페이지 갱신 발화 - 없으면 갱신만 건너뛴다), `CLOUDFLARE_PAGES_PROJECT_NAME`(알림 링크).
   선택: `SCENEPICK_WORKSPACE`, `CODEX_CLI_PATH`.
3. `codex/scenepick/AGENTS.md`는 리드가 저장소에 둔다(이 브랜치에는 없다). 없으면 job이 "발주 지침 파일이 없습니다"로 실패한다.

## 다시 발주 / 실패 처리

- **가장 쉬운 길: 같은 주제를 사회 봇에 다시 보낸다** - 새 job으로 발주한다.
- 같은 job을 다시 돌리기(맥미니): `npm run job:scenepick-poll -- <jobId> --force` (끝난·실패한 job도. 회차를 0부터 세고, 납품 폴더는
  지우지 않는다 - 이미 통과하는 납품이 있으면 Codex를 부르지 않고 받는다). 실패로 rejected가 된 job도 완료되면 approved로 바뀐다.
- 대기 중인 job을 취소: DB에서 `metadata.scenepickCodex.status`를 `failed`로(운영 DB 쓰기 - 승인 필요).
- 로그인 만료 알림("맥미니 codex 로그인 필요"): 맥미니 화면에서 `codex login` 후 다시 보내거나 `--force`.
- 대기만 쌓이고 아무 일도 없으면: 로그 파일 → `launchctl print gui/$(id -u)/com.blogautomation.scenepick-poll` → `which codex`(launchd PATH) 순.

## 파일

- 트랙: `src/notifications/telegramTracks.ts`(scenepick = 사회 봇 키 공유, 채널 없음), `src/config/manuscriptViewerPages.ts`(scenepick.html),
  `src/workflows/manuscripts/renderManuscriptPage.ts`(TRACK_PAGE_COPY.scenepick, 이미지 caption·출처 칸), `manuscriptManifest.ts`(`caption`·`sources` 필드),
  `src/workflows/publish/manualPublishOnly.ts`, `scripts/notifyWorkflowFailure.mjs`(트랙 표 사본)
- Worker: `cloudflare/telegram-relay/src/track.ts`(사회 일반 메시지 전달, 캡션은 인스타만), `index.ts`, `schedule.ts`
- 접수: `src/workflows/scenepick/scenepickIntake.ts`, `src/jobs/runTelegramUpdateCli.ts`
- 맥미니: `src/jobs/scenepickPollJob.ts`, `src/workflows/scenepick/{scenepickQueue,runScenepickJob,validateScenepickDelivery,buildScenepickEntry,scenepickPrompt,scenepickTypes}.ts`,
  `src/services/llm/runCodexWorkspace.ts`, `scripts/macmini/poll-scenepick.sh`, `scripts/macmini/com.blogautomation.scenepick-poll.plist.template`
- 테스트: `npm run test:scenepick`
