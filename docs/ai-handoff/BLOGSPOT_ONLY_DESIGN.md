# Blogspot 단독 운영 재설계 (2026-09-15 사용자 결정)

## 0. 결정과 이유

사용자 결정: **티스토리를 운영하지 않는다. 이 파이프라인이 만드는 모든 원고는 블로그스팟으로만 나간다.**

이유(사용자 원문 요약):
- 티스토리는 로그인이 자주 풀린다(카카오 세션). Playwright 반자동이 매번 사람 손을 탄다.
- 자동화 세팅 자체가 어렵다. 공식 API가 없어 에디터 DOM에 의존한다.
- 블로그스팟은 Blogger API v3 + 만료 없는 refresh token이 이미 확보돼 있어 **풀 자동화가 가능하다.**

그래서 "채널을 고르는 문제"를 아예 없앤다. 채널 배정·채널별 배리에이션·채널 트리는 전부 제거 대상이다.

부수 결정(같은 세션):
- 원고 뷰어는 채널 구분 없이 **하나**로 운영한다. 디자인·레이아웃은
  `~/Documents/blog-manuscripts/naver-parenting/viewer.html`과 동일하게, 포인트 컬러만 오렌지.
- **이미지 자동 생성 + 로컬 저장까지 먼저** 만든다. 자동 업로드는 원고·이미지 품질이 보장됐다고
  판단하는 시점에 켠다(코드는 미리 깔아두되 플래그 off).
- 티스토리 코드는 **완전 삭제**한다(복구는 git revert). dormant 코드를 남기면 다음 세션이 헷갈린다.
- 로컬 폴더는 `~/blog-automation/` 아래로 모은다. 원고 폴더(`Documents/blog-manuscripts`)는
  제자리에 두고 심볼릭 링크만 건다 — 그 아래 `naver-parenting`은 이 파이프라인과 무관한
  별개 수동 프로젝트라 경로를 흔들면 안 된다.

## 1. 바뀌는 파이프라인 전체 흐름

```
[매일 자동]
 키워드 수집(3종 cron)
   → 6-factor 스코어링 → TOP 10
   → 텔레그램 알림 (키워드 + seedQuery + 카테고리 + 20자 요약)

[대화형]
 Go 버튼
   → job-research.yml  자료조사
   → job-write.yml     집필  (확인 없이 자동 연결)
   → 텔레그램 초안 + [승인 / 수정 필요 / 반려]
        수정 필요 → 답장으로 방향 입력 → job-revise.yml → 재전송

[승인 이후]  ← 이번 재설계의 핵심 구간
 승인 콜백
   → job-publish-prepare.yml
        1) Blogspot 원고 생성 (배리에이션 1건, 채널 선택 없음)
        2) 이미지 자동 생성      ← NEW
        3) manifest upsert + 뷰어 페이지 렌더 + Cloudflare Pages 배포
   → 텔레그램 "원고 준비 완료" + 뷰어 딥링크

[사람]
 뷰어에서 본문 복사 → Blogger에 붙여넣기 → 발행
   ※ 품질 확인되면 이 구간을 job-publish-blogspot 자동 발행으로 대체
```

### 1-1. 지금과 달라지는 지점만

| 구간 | 지금 | 바뀐 뒤 |
|---|---|---|
| 채널 배정 | category → 티스토리/블로그스팟 (`channelRouting.ts`) | 없음. 항상 blogspot |
| 배리에이션 | 배정된 채널 1곳 | blogspot 1건 (채널 개념 삭제) |
| manifest | `topic.channels[]` 배열 | `topic.manuscript` 단일 객체 |
| 파일 경로 | `manuscripts/<날짜>/<주제>/<채널>.md` | `manuscripts/<날짜>/<주제>.md` |
| 뷰어 트리 | 날짜 → 주제 → 채널 (3단) | 날짜 → 주제 (2단) |
| 이미지 | writer가 프롬프트만 남김, 사람이 수동 생성 | 자동 생성 + Storage 업로드 + 로컬 미러 |
| 뷰어 이미지 | `[IMAGE PROMPT]` 텍스트 카드 | 실제 이미지 인라인 + 캡션 + 프롬프트 |

## 2. 데이터 모델 — 마이그레이션 없이 간다

`manuscript_manifest_topics.channels`(jsonb) 컬럼은 **그대로 둔다.** 컬럼을 지우거나 이름을 바꾸면
migration이 필요하고 그건 승인 게이트다(CLAUDE.md). 대신 코드 쪽 타입만 단일 객체로 바꾸고,
읽기/쓰기 경계에서만 배열 1칸과 매핑한다.

```ts
// manuscriptManifest.ts
type ManuscriptTopicEntry = {
  jobId; keyword; category; date; readyAt;
  manuscript: ManuscriptEntry;   // was: channels: ManuscriptChannelEntry[]
};

// row → topic :  manuscript = (row.channels ?? [])[0]
// topic → row :  channels   = [topic.manuscript]
```

과거에 쌓인 행(채널이 tistory인 것 포함)도 그대로 읽힌다 — `[0]`을 집으면 되고, 그 행의
`channel` 필드는 무시한다. 기존 원고가 뷰어에서 사라지지 않는다.

`ManuscriptEntry`에 이미지 필드를 더한다:

```ts
type ManuscriptImage = {
  index: number;          // 1부터. 본문 [IMAGE: ] 마커 순서와 일치
  description: string;    // [IMAGE: 설명]  → 캡션으로도 쓴다
  prompt: string | null;  // [IMAGE PROMPT: ...]
  url: string | null;     // Supabase Storage 공개 URL. 생성 실패면 null
  provider: string | null;// "openai" | "gemini"
  fileName: string;       // 로컬 미러 파일명. 예: 01-도입부.png
};
type ManuscriptEntry = {
  title; searchDescription; slug; tags; body; filePath;
  images: ManuscriptImage[];   // NEW (기존 imagePrompts를 흡수)
};
```

`images`가 비어 있는 과거 행은 뷰어가 `imagePrompts` 폴백으로 지금처럼 그린다.

## 3. 이미지 자동 생성

### 3-1. 프롬프트의 출처

새로 LLM에 브리프를 묻지 **않는다.** writer.md §8이 이미 본문에 남기는 마커 쌍을 그대로 쓴다.

```
[IMAGE: 광안리 드론쇼가 밤바다 위에 그림을 그리는 장면]
[IMAGE PROMPT: Night seaside drone light show over a city beach, ...]
```

`parseDraftFile.ts`가 이걸 `job.metadata.imagePrompts`로 빼두므로, 본문의 `[IMAGE:]` 마커 개수와
`imagePrompts` 길이가 같을 때만 1:1로 짝짓는다(다르면 이미지 생성을 건너뛰고 경고). 지금
`parseManuscriptBlocks`가 쓰는 검증과 같은 규칙이다.

기존 `buildImageBrief.ts` + `generateArticleImages.ts`(자체 브리프 생성 → 본문에 마크다운 삽입)
경로는 이번 설계에서 **쓰지 않는다.** writer가 문맥을 보고 쓴 프롬프트가 더 낫고, 본문을 다시
건드리지 않아야 뷰어의 블록 파싱이 안전하다. 코드는 지우지 않고 호출만 끊는다.

### 3-2. 언제 도는가

**승인 이후**, `prepareApprovedManuscripts` 안에서 원고 생성 직후. 반려·수정 중인 원고에 이미지
비용이 나가지 않게 하는 게 목적이다. job당 1회만 돈다 —
`job.metadata.imagesReadyAt`으로 멱등 처리(`channelManuscriptsReadyAt`과 같은 방식).

실패는 best-effort다. 이미지가 없어도 원고 준비는 success로 끝내고, 실패 사유만 남긴다.

### 3-3. provider — 1단계는 A/B 비교

사용자 결정: **첫 2~3건은 같은 프롬프트로 OpenAI·Gemini 양쪽을 만들어 뷰어에 나란히 띄우고,
직접 보고 고른 뒤 한쪽으로 고정한다.**

```
IMAGE_AB_COMPARE=true   → 프롬프트 1개당 2장(openai + gemini). 뷰어에 나란히.
IMAGE_AB_COMPARE=false  → IMAGE_PROVIDER 한쪽만. (비교 끝난 뒤 기본값)
```

- openai: `gpt-image-1`, quality=low, 1024x1024 — **2026-10-23 종료 예정 모델.** 비교에서
  이쪽이 뽑히면 후속 모델 전환이 바로 따라와야 한다.
- gemini: `gemini-3.1-flash-lite-image` (나노바나나 2 라이트)

원고당 장수는 writer가 남긴 마커 개수를 그대로 따른다(보통 3~5장). 상한만 `IMAGE_MAX_PER_ARTICLE`
(기본 6)로 걸어 폭주를 막는다. 비교 모드에서는 호출이 2배다.

### 3-4. 저장 — 클라우드가 원본, 로컬은 미러

GitHub Actions 러너는 매번 새 컴퓨터라 거기 쓴 파일은 사라진다(이번 세션에 이미 두 번 데인
지점 — manifest.json, research 파일). 그래서:

1. **원본**: Supabase Storage `article-images` 버킷. 공개 URL을 manifest에 적는다.
   뷰어(Cloudflare Pages에 배포됨)는 이 URL을 그대로 `<img src>`로 쓴다 — 로컬에서 file://로
   열어도 똑같이 보인다.
2. **로컬 미러**: 맥에서 `npm run sync:images`를 돌리면 manifest를 읽어 아직 없는 이미지를
   내려받는다. 사람이 Blogger 편집기에 올릴 실제 파일이 필요해서다.

```
~/Documents/blog-manuscripts/blogspot/<날짜>/<주제 슬러그>/
    01-도입부.png
    02-소제목1.png
    ...
    (비교 모드면 01-도입부-openai.png / 01-도입부-gemini.png)
```

자동 업로드를 켜는 시점에는 2번이 필요 없어진다(Blogger API가 Storage URL을 그대로 쓴다).
그래서 로컬 미러는 "지금 단계용 다리"다.

## 4. 원고 뷰어 재설계

`~/Documents/blog-manuscripts/naver-parenting/viewer.html`의 구성을 그대로 가져온다.
포인트 컬러(`--pen`)만 `#B23A2E` → 오렌지 `#E8590C`.

### 4-1. 좌측 (2단)

참조 파일의 "시리즈 그룹(접기/펼치기) → 글 버튼" 구조를 **날짜 그룹 → 주제 버튼**으로 매핑한다.
오늘 날짜 그룹만 펼쳐 둔다(없으면 가장 최근 날짜).

### 4-2. 우측 — 참조 파일과 같은 순서

1. 카테고리 배지 (참조의 series-badge 자리)
2. 제목 (doc-title)
3. 부제 줄 — 날짜 · 카테고리 · 본문 글자수 · 이미지 N장 (doc-sub)
4. `.hint` 붙여넣기 순서 안내
5. `.thumbrow` 대표 이미지 + 훅 요약
6. `.meta-grid` 제목 / 검색 설명 / 슬러그 / 태그 (각 행 복사 버튼)
7. `.toolbar` — 본문 복사(서식 유지) · 본문 평문 복사 · 이미지 프롬프트 복사 · 수정
8. `캡션 N줄` 표 (이미지별 캡션 + 복사)
9. `#preview` 본문 — **실제 이미지 인라인**, figure + figcaption(캡션)
10. `이미지 생성` 프롬프트 팩 `<pre>`

본문 복사는 지금 규칙을 유지한다: 이미지 자리는 `[[이미지 N]]` 마커로 남기고, 맨 끝에 해시태그
한 줄이 따라붙는다.

### 4-3. 유지하는 것

- 모바일 드로어(햄버거) — 참조 파일에 없지만 사용자가 폰으로 본다. 데스크톱은 참조와 동일한
  고정 사이드바.
- `localStorage` 수정 기능, `#jobId` 딥링크(채널 부분이 빠진다), 토스트.

## 5. 자동 업로드 (다음 단계, 지금은 플래그 off)

`publishArticleToBlogspot.ts`와 Blogger 인증은 이미 있다. 켜는 조건은 **품질 판단**이고 그건
사용자가 정한다. 준비만 해 둔다:

- `BLOGGER_AUTO_PUBLISH` (기본 false). true면 승인 직후 `job-publish-blogspot.yml`이 돈다.
- `BLOGGER_PUBLISH_AS_DRAFT`는 그대로 true 유지 — 자동 업로드 1단계는 "비공개 초안까지".
  공개 발행은 그다음 결정.
- 일일 상한 `BLOGGER_DAILY_LIMIT=5` 유지.

이 단계에서 본문 HTML의 `[[이미지 N]]` 마커는 Storage URL `<img>`로 치환해서 올린다.

## 6. 삭제 목록 (티스토리)

```
삭제
  src/services/publish/tistory/          (TistoryPublisher, setup/inspect/live 스크립트)
  src/workflows/publish/publishArticleToTistory.ts
  src/workflows/publish/testPublishArticleToTistory.ts
  src/config/channelRouting.ts
  src/config/testChannelRouting.ts
정리
  src/config/publishTargets.ts           TISTORY_CONFIG / TISTORY_CATEGORY_BY_INTERNAL 제거
                                         BLOGSPOT_LABEL_BY_INTERNAL에 incident 추가
  src/workflows/publish/publishApprovedArticles.ts   tistory 채널 분기 제거
  src/workflows/publish/notifyMultiPublish.ts        라벨 제거
  src/config/pipelinePaths.ts            ManuscriptChannel 타입 삭제, 경로에서 채널 단계 제거
  package.json                           setup:tistory / inspect:tistory / debug:live-tistory
                                         / test:publish-tistory 스크립트 제거
  .env                                   TISTORY_* 4개 (사용자가 직접 정리)
```

네이버 관련 dormant 코드는 이번 삭제 범위가 **아니다** — 사용자가 별도 프로세스로 재설계
예정이라 했고(2026-09-07), 그 결정은 바뀌지 않았다.

## 7. 로컬 폴더 정리

```
지금                                     바뀐 뒤
~/Documents/blog-automation   (메인)     ~/blog-automation/repo
~/blog-automation-prod        (worktree) ~/blog-automation/prod
~/blog-automation-kw          (worktree) ~/blog-automation/kw
~/Documents/blog-manuscripts             그대로 + ~/blog-automation/manuscripts 심볼릭 링크
```

worktree는 `.git` 파일에 메인 repo 절대경로를, 메인 repo는 `.git/worktrees/*/gitdir`에 worktree
절대경로를 서로 적어 둔다. 둘 다 옮기므로 이동 후 `git worktree repair`를 양쪽에서 돌려야 한다.

절대경로를 박아 쓰는 곳은 문서 3개와 `scripts/statusDashboard.ts`뿐이고, launchd plist는 전부
`.disabled`라 실행 경로 의존이 없다. 이동 자체는 안전하다.

**단, 이동은 맨 마지막에 한다** — 지금 세션의 작업 디렉터리가 `~/blog-automation-prod`이고,
그 밑이 사라지면 세션이 끊긴다. 이동 후에는 새 경로에서 세션을 다시 연다.

## 8. 대시보드 반영

데일리 데스크(`제이든의 데일리 데스크`)의 blog-automation 패널은 아티팩트 DB
`progress/blogAutomation` 문서를 읽고, 그 문서는 `docs/ai-handoff/PROGRESS.md`에서 집계된다.

**지금 그 파일이 없다.** DB에 남은 값도 2026-09-04자 스프린트 목록이라 죽어 있다. 이번 재설계
마일스톤으로 `PROGRESS.md`를 새로 만들고 DB를 갱신한다. 이후에는 `- [ ]` → `- [x]`만 바꾸면
다음 동기화 때 진척률이 따라 움직인다.

## 9. 작업 순서

1. 이 문서 + `PROGRESS.md` 작성
2. 티스토리 삭제 + 채널 단일화 (타입/경로/manifest/배리에이션/테스트)
3. 뷰어 재설계 (참조 파일 이식 + 오렌지)
4. 이미지 자동 생성 (생성 → Storage → manifest → 뷰어 → 로컬 sync)
5. 대시보드 DB 갱신 + 파이프라인 아티팩트 갱신
6. 문서 최신화 + main 병합
7. 로컬 폴더 이동 (세션 재시작 필요)

자동 업로드(5절)는 사용자가 품질을 판단한 뒤 별도로 착수한다.
