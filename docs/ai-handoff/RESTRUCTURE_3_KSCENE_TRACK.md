# 개편3 — 사용설명서 트랙 (The Korea Manual)

기준 문서: `RESTRUCTURE-PLAN-2026-10.md` §4.2~4.3 (저장소 밖 `/Users/wooahpapa/blog-automation/`). 구현일 2026-10-06, 브랜치 `feat/restructure-3-kscene-track`.
트랙 레이어(봇 분기·웹훅·`job.metadata.track`)는 개편2 것을 그대로 쓴다 - `docs/ai-handoff/RESTRUCTURE_2_SOCIAL_TRACK.md`.

## 흐름

```
21:00 KST  Worker 12 UTC 슬롯 ─┬─ kscene-topic.yml ── 영문 자동완성 → 주제 5~10건 → 사용설명서 봇 Go/Pass
                              └─ watchdog.yml (GitHub cron 폐지, 전날 kscene 수집을 확인)
Go → research → write (한글 초고, category=kscene, style/kscene.md)
한글 초고 ✅ ──► ksceneStage=translating ──► job-translate.yml (영어본 + 한글 대역 요약)
영어본 재승인(✅/✏️/🗑) ── ✅ ──► job approved → job-publish-prepare(이미지) → 🔵 Blogger 발행 버튼
🔵 Blogger 발행 ──► 이미지 공개 Pages로 복사·URL 치환 ──► K-Scene blogId(KSCENE_BLOGGER_BLOG_ID)로 공개 발행
```

## 어디를 보나

| 하는 일 | 파일 |
|---|---|
| 21:00 주제 수집 job / 워크플로 | `src/jobs/ksceneTopicJob.ts`, `.github/workflows/kscene-topic.yml`, `src/workflows/kscene/runKsceneTopicCollection.ts` |
| 시드(기본 60개)·라벨·조절값 | `src/config/ksceneSeeds.ts` — **⑤의 시드 50~100개가 오면 이 배열을 교체·확장** |
| 후보 선정(제외·점수·중복·라벨 다양성) | `src/workflows/kscene/ksceneTopics.ts` |
| 자동완성 조회 | `src/services/search/providers/googleAutocomplete/fetchAutocomplete.ts` |
| 한글 초고 규격 | `prompts/writing/style/kscene.md`, `specFiles.ts`(`pickStyleFile`), `buildWritingPrompt.ts`/`buildResearchPrompt.ts`(kscene 지시) |
| **번역·현지화 지침(⑤가 교체)** | `prompts/translation/kscene-ko-en.md` — **임시 기본본**. 통째로 교체해도 출력 계약은 코드가 따로 덧붙인다 |
| 번역 계약(구분자·마커 보존·링크·한글 잔존 검증) | `src/workflows/translation/{buildTranslationPrompt,parseTranslationOutput}.ts` |
| 번역 실행·상태 기계 | `src/workflows/translation/runTranslateJob.ts`, `ksceneStage.ts`, `job-translate.yml`(`npm run job:translate`) |
| 영어본 재승인 알림 | `src/workflows/translation/notifyEnglishReview.ts` |
| 2단계 승인(콜백 분기) | `src/notifications/TelegramBot.ts`(`handleArticleReviewCallback`·`handleEditFeedbackMessage`), `runTelegramUpdateCli.ts`(`triggerTranslation`) |
| 발행 타깃 분기·라벨·이미지 치환 | `src/workflows/publish/publishArticleToBlogspot.ts`(`resolveBloggerTarget`), `config/publishTargets.ts`(`KSCENE_BLOGGER_BLOG_ID`) |
| 이미지 호스팅(Pages) | `src/services/images/rehostImagesToPages.ts`, `config/ksceneImages.ts` |
| watchdog | `src/jobs/watchdogJob.ts`(`WATCHED_JOBS`의 `dayOffset: -1`), `cloudflare/telegram-relay/src/schedule.ts` |

## 설계 결정

- **한글 ✅는 최종 승인이 아니다.** `job.metadata.ksceneStage`(`translating` → `english_review` / `translation_failed`, 컬럼이 아니라 jsonb라 migration 없음)가 단계를 정하고, 같은 `review:confirm` 콜백이 단계로 "한글 승인(영어본 생성)"과 "영어본 승인(최종)"을 가른다. job.status는 영어본이 승인될 때까지 `review`다 - 이미지 비용·발행 버튼이 영어본 승인 뒤에만 열린다.
- **영어본은 새 article 행(platform="blogspot")**이다. `pickFinalArticle`이 "기준 원고보다 새로운 blogspot 행"을 최종본으로 고르므로 준비·발행이 코드 변경 없이 영어본을 읽는다. 한글 원고는 기준 행으로 남아 재번역의 원본이 된다. 영어 발행 메타(검색 설명·slug·태그)는 `channelMeta.blogspot`.
- **이미지 마커는 번역에서 개수·순서·획득 방식(`— 웹 검색` 등)을 보존해야 통과**한다(검증 실패 시 오류를 되먹여 1회 재시도). 이미지 검색어(`metadata.imagePrompts`)가 번호로 짝지어지기 때문이다. `prepareManuscript`는 영어본(`translation.articleId`)이면 한글 설명과의 토큰 정렬(`alignImagePrompts`)을 우회한다.
- **영어본 수정 요청은 한글을 다시 쓰지 않는다** - 영어본만 `job-translate`로 다시 만든다(사실의 기준은 한글 원고).
- **`KSCENE_BLOGGER_BLOG_ID`가 비어 있으면 발행하지 않는다**(`BLOGGER_BLOG_ID`로 폴백 금지 - 영어 글이 whynowissue로 간다).
- **번역은 heavy-pipeline 큐를 타지 않는다**(가벼운 텍스트 변환이라 긴 집필 뒤에 줄 서지 않게). job별 concurrency 그룹.
- **시드는 DB가 아니라 코드(`ksceneSeeds.ts`)**다 - `seed_queries`에 track 컬럼을 넣으면 migration(승인 게이트)이고 영문 시드가 한국 NAVER 수집에 섞인다. 기발행·기제안 중복은 `article_jobs`(kscene 트랙)와 최근 60일 kscene 제안으로 거른다.
- **watchdog은 kscene 수집과 같은 시각에 깨어난다** - 오늘분을 기다리면 매일 거짓 경보라 `dayOffset: -1`(전날 수집일 이후 완료 run)로 본다. 하루 늦게 잡히는 대신 거짓 경보가 없다.
- **이미지 호스팅**: Pages 배포는 사이트 **스냅샷**이라 오늘 이미지만 올리면 어제 것이 지워진다. `manifest.json`으로 이전 파일을 전부 내려받아 재구성한 뒤 한 번에 배포하고, 이전 파일을 하나라도 못 받으면 **배포하지 않는다**(Supabase URL로 발행). 전부 옮겼을 때만 `imagesRehostedAt`을 남기고, 그때부터 storage-cleanup이 Supabase 원본을 정리 대상으로 본다(whynowissue 옛 글은 계속 보존).

## 검증 (로컬, 네트워크·운영 DB 없음)

`npm run build` 통과. 신규: `test:kscene-topics` · `test:translation` · `test:kscene-approval` · `test:rehost-images`. 확장: `test:watchdog` · `test:relay-schedule` · `test:spec-files` · `test:publish-blogspot` · `test:notify-manuscripts-ready` · `test:notify-article` · `test:storage-cleanup` · `test:prepare-manuscripts`. 기존 회귀(`test:relay-track` · `test:relay-fetch` · `test:telegram-tracks` · `test:manuscript-track-pages` · `test:format-notification-message` · `test:writing-prompt` · `test:research-prompt` 등) 통과.
`test:worker-cron`은 개편1 이후 이미 깨져 있다(`SCHEDULED_WORKFLOWS`가 `schedule.ts`로 이동) - `test:relay-schedule`이 대신한다.
`test:telegram-bot`은 일부 단계가 실제 Supabase를 요구한다(코드 변경과 무관, 50단계까지 통과).

## 아직 안 한 것 = 승인·사용자 작업이 필요한 것 (순서대로)

1. **main 병합·push** (이 순서가 중요: 워크플로 파일이 main에 있어야 Worker dispatch가 404가 아니다).
2. **GitHub 설정**: secret/variable `KSCENE_BLOGGER_BLOG_ID`(`506709987398630214`, secret·variable 어느 쪽이든). 이미지 호스팅을 켤 때만 variable `KSCENE_IMAGES_PAGES_PROJECT`(+선택 `KSCENE_IMAGES_BASE_URL`). `KSCENE_TELEGRAM_*` secret은 이미 등록됨. repo의 `BLOGGER_ENABLED`는 공유 게이트다(켜져 있어야 한다).
3. **Worker 재배포**: `cd cloudflare/telegram-relay && npx wrangler deploy` (12 UTC가 kscene-topic + watchdog을 깨우도록). `--dry-run` 먼저.
4. **Worker secret + 웹훅(외부 설정 변경)**: `echo -n "<봇 C 토큰>" | npx wrangler secret put KSCENE_TELEGRAM_BOT_TOKEN`(파이프 필수), 그리고 `https://<worker>/webhook/kscene`를 메인·사회 봇과 같은 `secret_token`·`allowed_updates`로 `setWebhook`. **이게 없으면 사용설명서 봇의 버튼이 아무 일도 안 한다.**
5. **이미지 Pages 프로젝트 1회 생성**(공개): `npx wrangler pages project create <이름> --production-branch main`, 그 이름을 `KSCENE_IMAGES_PAGES_PROJECT`에. 비워 두면 Supabase URL로 발행되고 Supabase 이미지는 정리되지 않는다.
6. **번역 지침 교체**: ⑤가 설계한 프롬프트 본문으로 `prompts/translation/kscene-ko-en.md`를 덮어쓴다(지금은 임시 기본본). 시드 50~100개로 `ksceneSeeds.ts`도.
7. **첫 실운영 확인**: 21:00 주제 수신 → Go → 한글 초고 → ✅ → 영어본 재승인 알림 → ✅ → 🔵 Blogger 발행(처음엔 `BLOGGER_PUBLISH_AS_DRAFT`와 무관하게 버튼은 **공개 발행**임에 유의 - 첫 건은 이미지 호스팅을 켜기 전에 한 번 확인하길 권한다).
8. 맥미니는 건드릴 것이 없다(이 개편은 클라우드 전용).

## 알려 둔 한계

- 영어본 생성은 **GitHub dispatch가 실패하면** `translating`에서 멈춘다(25분 뒤 한글 ✅를 다시 누르면 재시작). Worker 로그·Actions 목록에서 확인.
- 이미지 Pages 복사: 같은 프로젝트에 동시 발행 두 건이 겹치면 나중 배포가 먼저 것의 신규 파일을 덮을 수 있다(스냅샷 재구성이 서로를 못 본다). 사람이 버튼을 누르는 저빈도 작업이라 락은 두지 않았다. 파일이 19,000개에 닿으면 새 프로젝트로 넘어가라는 오류로 멈춘다.
- 이미지를 옮긴 글을 14일 뒤 정리한 다음 같은 글의 이미지를 **수정해 다시 발행**하면, 새 이미지 원본이 이미 지워졌을 수 있다(대응 없는 새 이미지는 발행 때 다시 복사되지만 원본이 없으면 실패 → 그 자리 URL이 깨진다). 드문 경우.
- 사용설명서 글의 내부 링크(`appendRelatedPosts`)는 영어본 경로에서 붙지 않는다(옛 배리에이션 재사용 경로와 같은 이유). kscene 글끼리의 내부 링크는 후속 과제.
- 21:00 주제 제안의 20자 요약(`generateKeywordSummaries`)은 한국어 뉴스용 프롬프트를 영문 질의에 그대로 쓴다 - 한국어로 의미를 풀어 주므로 쓸 만하지만 전용 프롬프트가 아니다.
- watchdog 도입 첫날은 전날 kscene run이 없어 사용설명서 항목이 한 번 경보를 낼 수 있다.
