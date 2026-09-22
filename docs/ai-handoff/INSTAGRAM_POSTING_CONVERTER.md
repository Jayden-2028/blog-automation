# 인스타 포스팅 변환기 — 인수인계

> **이 문서만 읽으면 이어서 작업할 수 있다.** 2026-09-21 시작, 별도 세션(`ig-dev`,
> 브랜치 `feat/instagram-keyword-source`)에서 작업. `INSTAGRAM_KEYWORD_SOURCE.md`(Business
> Discovery API 설계)를 대체한다 - 그 설계는 App Review 벽 때문에 폐기됐다.

## 왜 이 구조인가

원래 목표는 인스타그램 이슈 페이지를 자동으로 훑어 키워드를 뽑는 것이었다. 두 가지가 막혔다.

1. **Meta Business Discovery API**: 남의 계정은 물론 본인 계정 조회도 error code 10
   ("Application does not have permission for this action")으로 막힌다. App Review의
   Advanced Access가 필요하고, 그건 사업자등록(Business Verification)이 전제조건이다 - 지금
   없다.
2. **Playwright 크롤링**: `instagram.com/robots.txt`가 지정 안 된 user-agent 전체를 차단한다
   (`Disallow: /`). 이 프로젝트가 네이트판·다음카페·네이버카페를 robots.txt 기준으로 이미
   제외해온 것과 같은 원칙이라 인스타에만 예외를 둘 수 없다.

그래서 **수집을 자동화하는 대신 사람이 직접 인스타를 훑고, 쓰고 싶은 게시물 URL만 텔레그램으로
보내면 Claude가 나머지(분석·자료조사·원고화)를 처리**하는 반자동 구조로 바꿨다.

## 사용자가 이미 결정한 것 (재논의 금지)

| 항목 | 결정 |
|---|---|
| 소스 발견 | 사람이 인스타 앱/웹에서 직접 훑는다. 자동 수집 안 함 |
| 접수 채널 | 별도 텔레그램 봇("인스타 포스팅 변환기", `InstaTransitionBot`). 기존 키워드 알림 봇과 완전 분리 |
| 이미지 저작권 판단 | **이미지의 최종 사용 여부는 사람이 승인 단계에서 판단한다.** 시스템은 후보만 준비 |
| 이미지 재가공 기준 | 디자인/워터마크/번인 텍스트가 있는 컷은 **직접 캡처해서 못 쓴다**. 대신 동일 이미지를 웹에서 찾아 원본(깨끗한 버전)을 쓴다 (아래 "이미지 소싱 정책" 참고) |
| 임베드 | 필요할 때만, **개별 포스팅이 아니라 프로필 단위**로 (원고 내용이 풍부해질 때만) |
| 원고 뷰어 | 기존 뷰어(`manuscripts/index.html`)에 통합. 인스타 소스는 배지 + 제목 음영으로 표시 |
| 기존 파이프라인 | article_jobs 상태머신·리서치/집필 프롬프트·이미지 업로드·뷰어를 그대로 재사용. DB 마이그레이션 0건 |

## 이미지 소싱 정책 (2026-09-21 수정 — 중요)

**최초 설계는 "캐러셀을 슬라이드하며 이미지 영역을 캡처"를 기본으로 가정했는데, 이게 틀렸다.**

사용자 실측 판단: 인스타에 올라오는 이미지 대부분은 **재가공된 컷**이다 - 워터마크, 계정 로고,
번인된 텍스트가 박혀 있다. 이런 컷은 캡처해서 그대로 쓸 수 없는 경우가 캡처 가능한 경우보다
**더 많다**. 반면 이 채널이 고르는 사진 자체(구도·소재)는 일반 블로그 이미지보다 품질이 좋은
경우가 많아서, **이미지를 포기하지 않고 "같은 사진의 원본(깨끗한 버전)"을 웹에서 찾아 쓰는 쪽이
기본 경로**가 되어야 한다.

### 캡처 세션(사람 = Claude가 브라우저로 직접 수행)에서 슬라이드마다 할 일

1. **판단 우선**: 워터마크/로고/번인 텍스트가 있는가?
   - **없음(플랫한 단컷 사진)** → 그 슬라이드는 직접 캡처해서 후보로 쓴다 (`kind: "instagram_capture"`).
   - **있음(대부분 이 경우)** → 직접 캡처하지 않는다. 대신:
2. **동일 이미지 웹 검색(기본 경로)**: 캐러셀 이미지 하나를 가지고 **구글 이미지 검색("이미지로
   검색"/Google Lens 방식, 이미지 업로드 또는 이미지 URL 붙여넣기)**으로 같은 원본 사진이 어디에
   올라와 있는지 찾는다. 뉴스 기사, 원 촬영자 페이지, 스톡 사이트 등에서 깨끗한(재가공 안 된)
   버전을 찾으면 그걸 후보로 쓴다 (`kind: "web_alternative"`, `sourcePage`에 출처 기록).
   - 키워드 텍스트 검색(`searchNaverImages`)은 "동일 이미지"가 아니라 "비슷한 주제 이미지"만
     찾으므로 이 용도에는 약하다 - 정확히 같은 사진을 찾는 목적에는 리버스 이미지 검색이 맞다.
   - 못 찾으면 그 슬라이드는 포기하거나(원고에서 해당 마커 제외), 주제가 비슷한 대체 이미지를
     `searchNaverImages`로 보강 검색한다(차선책).
3. **번인 텍스트는 이미지와 별개로 항상 기록한다** (`InstagramCaptureResult.burnedInText`) -
   이미지를 못 쓰더라도 정보 슬라이드에 적힌 텍스트 자체는 리서치 1차 근거로 쓴다
   (`buildResearchPrompt.ts`가 이미 이 필드를 "1차 근거"로 주입한다).
4. 최종적으로 어떤 이미지를 쓸지는 **사람(사용자)이 원고 뷰어/승인 단계에서 판단**한다 - 이 단계는
   후보를 준비할 뿐이다.

리버스 이미지 검색은 API가 아니라 **브라우저로 수행**한다(Google Vision API 등 유료 API를 쓰지
않는다 - 이 프로젝트의 "무료 수단만" 원칙과 일치, 그리고 어차피 캐러셀 확인 자체가 브라우저
세션이 필요한 작업이라 같은 세션에서 이어서 하면 된다).

## 아키텍처

```
텔레그램(사용자가 URL+캡션 전송)
  → InstagramCaptureBot (별도 봇, InstaTransitionBot)
  → 로컬 큐 (data/instagram-queue.jsonl, git 비추적)
  → [사람이 부를 때] Claude가 브라우저로 캡처 세션 수행
      - 캐러셀 슬라이드별 판단(위 "이미지 소싱 정책")
      - 번인 텍스트 기록
  → createInstagramJob() : article_jobs row 생성(status=selected, selected_via=manual)
      + 후보 이미지를 Storage 업로드, job.metadata.instagramImages에 저장
  → (기존 파이프라인) npm run job:research -- <jobId>
  → npm run job:write -- <jobId>   ← 완료 시점(마커 수 확정)에 instagramImages를 자동으로
                                      metadata.images로 승격함(2026-09-22 수정, 아래 "현재 상태" 참고)
  → (기존 파이프라인) 리뷰 → 승인 → prepareApprovedManuscripts → 원고 뷰어
```

캡처 시점엔 캐러셀 슬라이드 수만 알고, 실제로 원고에 몇 개의 `[IMAGE:]` 마커가 생길지는
`job:write` 완료 후에만 안다 - 그래서 후보는 일단 `metadata.instagramImages`에 넣어두고,
`job:write`가 마커 수를 확정하는 순간 그 수만큼 잘라 `metadata.images`로 옮긴다(마커보다 후보가
많으면 넘치는 건 버림). `npm run ig:promote-images -- <jobId>`는 이 수정 전에 만들어진 job을
수동으로 복구할 때만 쓰는 안전망 CLI다.

## 캡처 결과 JSON (캡처 세션 -> job)

캡처 세션은 슬라이드 판단을 마친 뒤 이 모양의 JSON 파일을 쓰고 `npm run ig:create-job`에 넘긴다.
예전에는 `createInstagramJob()`을 부르는 코드가 없어 매번 일회용 스크립트를 짜야 했다(2026-09-22
이전). 이제는 이 파일 하나가 계약이다.

```json
{
  "queueEntryId": "42",
  "instagramUrl": "https://www.instagram.com/p/XXXX/",
  "caption": "게시물 캡션 원문(없으면 \"\")",
  "burnedInText": ["정보 슬라이드에 박힌 텍스트", "..."],
  "searchKeyword": "자료조사·원고의 주제어",
  "category": "entertainment",
  "images": [
    { "slideIndex": 1, "kind": "instagram_capture", "localPath": "/abs/path/slide1.png" },
    { "slideIndex": 2, "kind": "web_alternative", "localPath": "/abs/path/slide2.jpg",
      "sourcePage": "https://news.example/article", "note": "리버스 검색으로 찾은 원본" }
  ],
  "profileEmbedUrl": null
}
```

- `category`는 `incident` / `entertainment` / `ott` / `parenting` / `living` / `community` 중
  하나이거나 `null`이다(`keywordCategoryRules.ts`의 `KeywordCategory`).
- `kind`가 `web_alternative`면 `sourcePage`가 **필수**다 - 저작권 판단을 사람이 하기로 한
  정책(위 "이미지 소싱 정책")의 근거가 거기서 나온다.
- 같은 `slideIndex`에 `instagram_capture`와 `web_alternative`를 함께 두면 뷰어가 A/B로 나란히
  띄운다. 같은 kind를 두 번 두는 것은 거부된다.
- `burnedInText`는 **이미지를 못 쓰더라도 항상 채운다** - `buildResearchPrompt.ts`가 이걸 리서치
  1차 근거로 주입한다.

```bash
npm run ig:create-job -- capture.json --dry-run   # 검증만, 아무것도 쓰지 않는다
npm run ig:create-job -- capture.json             # job 생성 + 이미지 업로드 + 큐 항목 done 표시
```

`--dry-run`은 Supabase 자격증명 없이도 돈다(그쪽 모듈을 실제로 쓸 때만 부른다). 규격 오류는
하나씩이 아니라 **모아서** 보고하고, 큐에 없는 `queueEntryId`·이미 처리된 항목·없거나 0바이트인
이미지 파일도 **쓰기 전에** 막는다 - job row가 먼저 생기면 되돌리기가 번거롭기 때문이다.

## 코드 위치

```
src/notifications/InstagramCaptureBot.ts          텔레그램 폴러(기존 TelegramBot.ts와 완전 분리)
src/jobs/instagramCapturePollJob.ts                CLI 진입점(launchd가 60초마다 호출)
src/workflows/instagram-capture/types.ts           공용 타입 (InstagramCaptureResult 등)
src/workflows/instagram-capture/instagramQueue.ts  로컬 JSONL 큐
src/workflows/instagram-capture/createInstagramJob.ts   캡처 결과 -> article_jobs
src/workflows/instagram-capture/createInstagramJobCli.ts     캡처 JSON -> job(검증 포함)
src/workflows/instagram-capture/parseCaptureFile.ts     캡처 JSON 검증·정규화
src/workflows/instagram-capture/selectPromotableImages.ts  후보 -> images 승격 규칙(유일한 기준)
src/workflows/instagram-capture/processPendingCaptures.ts    대기열 -> 캡처 -> job(폴러가 부른다)
src/workflows/instagram-capture/runCaptureSession.ts    캡처 1건 오케스트레이션(정책 적용)
src/workflows/instagram-capture/captureInstagramCarousel.ts  Playwright 캐러셀 캡처(맥 전용)
src/workflows/instagram-capture/judgeCarouselSlides.ts  슬라이드 판정(헤드리스 claude -p)
src/workflows/instagram-capture/findCleanAlternative.ts   오버레이 슬라이드의 대체 이미지
src/workflows/instagram-capture/promoteInstagramImagesCli.ts  이미지 승격
src/workflows/instagram-capture/showQueueStatusCli.ts   대기열 확인
```

```
npm run job:ig-capture-poll     텔레그램 폴링 1회(launchd가 60초 주기로 호출)
npm run ig-capture:status       대기 중인 큐 항목 확인
npm run ig:create-job -- <json> [--dry-run]   캡처 JSON -> job
npm run ig:promote-images -- <jobId>   job:write 이후 이미지 승격
npm run test:instagram-capture-bot     봇 로직 단위 테스트(4건)
npm run test:ig-promote                승격 규칙 불변식(8건)
npm run test:ig-capture-file           캡처 JSON 검증 규격(11건)
npm run test:ig-capture-session        캡처 세션 정책·실패 처리(8건)
npm run test:ig-capture-queue          대기열 재시도·포기 규칙(8건)
```

## 현재 상태 (2026-09-21)

- 코드 전부 작성·빌드·테스트 통과(`npm run build`, 관련 테스트 5종).
- 텔레그램 봇(`InstaTransitionBot`) 생성 완료, `.env`(`INSTAGRAM_BOT_TOKEN`/`INSTAGRAM_BOT_CHAT_ID`)
  설정 완료, 실제 메시지로 큐 적재까지 검증함.
- launchd 등록 완료: `com.wooahpapa.blog-automation.instagram-capture-poll` (60초 주기,
  `scripts/poll-instagram-capture.sh` → `ig-dev` 워크트리를 가리킴). **`main` 병합 전 임시
  상태 - 병합되면 `prod`를 가리키도록 plist와 스크립트를 옮겨야 한다.**
- **엔드투엔드 1건 실행함 - 그리고 설계 결함을 하나 발견함(2026-09-22).** job `163f9629`
  ("김지원 밀라노 근황")으로 캡처 세션(브라우저) → job 생성 → research → write까지 돌렸다.
  리버스 이미지 검색은 이번엔 필요 없었다(캐러셀 슬라이드8이 슬라이드1 표지의 번인 없는
  원본이라 그대로 썼다).

  **결함**: `ig:promote-images`를 돌리기 전에 review→approve와 `channelManuscriptsReadyAt`
  (최종 변주 원고 준비)까지 자동으로 다 끝나버렸다. `job:write` 완료 후 사람이 텔레그램에서
  승인(✅)하면 그 즉시 `prepareApprovedManuscripts` 계열이 돌아 최종 원고를 만드는데, 그 시점에
  `metadata.images`가 비어 있으면 **기존 파이프라인의 기본 동작(웹 이미지 자동 검색)이 대신
  채운다** - 인스타에서 캡처한 사진과 무관한, 키워드로 검색된 엉뚱한 사진(이 사례에서는 다른
  행사·다른 드라마 스틸)이 최종 원고에 들어갔다. `ig:promote-images`는 여전히 수동 단계라
  승인이 그보다 먼저 일어나면 이렇게 어긋난다.

  **수정 완료(2026-09-22).** `runArticleJob.ts`의 `runWritingStageInner`에 자동 승격 로직을
  추가했다 - `job:write`가 draft를 파싱해 `[IMAGE PROMPT:]` 마커 수(`parsed.imagePrompts.length`)를
  확정하는 바로 그 시점에, `metadata.source === "instagram_manual"`이고
  `metadata.instagramImages`가 있으면 그 자리에서 곧바로 마커 수만큼 잘라 `metadata.images`에
  써 넣는다(`promoteInstagramImagesCli.ts`와 같은 규칙). 이게 review 상태 전이·텔레그램 알림보다
  먼저 같은 함수 안에서 일어나므로, 사람이 아무리 빨리 승인 버튼을 눌러도 더 이상 경쟁 상태가
  생기지 않는다. `ig:promote-images` CLI는 이제 안전망으로만 남는다(이미 승격된 job에는
  아무 일도 안 함) - **새 job부터는 별도로 돌릴 필요 없다.**

  job `163f9629`("김지원 밀라노 근황")처럼 **이 수정 전에** 이미 어긋난 job은
  `npm run ig:promote-images -- <jobId>`로 `metadata.images`(DB 원본)는 고칠 수 있지만,
  이미 만들어진 최종 변주 원고·뷰어·발행 버튼에 반영하려면 `job:revise -- <jobId>`를 별도로
  돌려야 한다(텔레그램 알림 재전송 동반 - 사용자 승인 필요, 2026-09-22 기준 `163f9629`은
  사용자 요청으로 보류 중 - 건드리지 말 것).

## 다음 단계

1. job `163f9629`을 사용자가 어떻게 마무리할지 판단(보류 중, 2026-09-22) - `job:revise`로
   재생성할지, 이번 건은 그냥 두고 다음 건부터 고칠지.
2. 큐에 쌓인 나머지 게시물(2026-09-22 기준 7건 대기)을 순서대로 캡처 세션 처리.
3. 문제없으면 `main`에 병합하고 launchd를 `prod`로 옮긴다.

## 절대 하지 말 것

- `prod` 워크트리와 `main` 브랜치를 직접 건드리지 않는다(병합 전까지).
- 리버스 이미지 검색·캡처 세션을 API/유료 서비스로 자동화하려 하지 않는다 - 사람 판단이 필요한
  단계라 브라우저 수행이 설계 의도다.
- `.env` 값을 읽거나 출력하지 않는다.
