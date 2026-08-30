# Sprint 5 설계 — 다채널 자동 발행 (Blogspot + 티스토리)

작성일: 2026-08-30 · 상태: **설계 초안, 결정 대기**(결정 항목은 §9) · 브랜치 `claude/multi-platform-publish`

## 1. 배경

Sprint 4로 네이버는 "승인 원고 → 임시저장함까지 자동, 발행 버튼은 사람"이 완성됐다. 이번엔
발행 채널을 넓힌다. 사용자 지시(2026-08-30): **티스토리 + Blogspot에 원고 승인 후 자동
업로드까지**.

로드맵(§Sprint 5+ 2번)이 순서를 이미 정해놨다: `WordPress → Blogspot → 티스토리`, 기술 난이도
순. WordPress는 이번 범위에서 뺀다(사용자 지시). **Blogspot을 먼저** 붙이고 티스토리를 뒤에
붙인다.

## 2. 핵심 사실 — 두 플랫폼의 접근 경로가 다르다

| | Blogspot (Blogger) | 티스토리 |
|---|---|---|
| 공식 API | **Blogger API v3, 정상 운영** (`posts.insert`, OAuth 2.0) | **없음. Open API 2024-02 완전 종료** |
| 발행 방식 | HTTPS API 호출 1건 | 브라우저 자동화(Playwright)뿐 — 네이버와 같은 처지 |
| 완전 자동 발행 | 정당·저위험 (구글 공식 경로) | 가능하나 계정 스팸 판정 위험 (네이버와 동일) |
| 인증 | GCP OAuth client + refresh token (최초 1회 동의) | 로그인된 persistent 프로필 (네이버 방식 재사용) |
| 이미지 | 본문 HTML의 외부 `<img src>` 그대로 사용 (Supabase 공개 URL) | Playwright 파일 업로드 or HTML 모드 외부 `<img>` |

출처: [Blogger API v3 posts.insert](https://developers.google.com/blogger/docs/3.0/reference/posts/insert) ·
[티스토리 Open API 종료 안내](https://tistory.github.io/document-tistory-apis/)

**결론**: Blogspot은 API로 진짜 "완전 자동 발행"이 안전하게 된다. 티스토리는 네이버와 똑같이
브라우저 자동화이고, 완전 무인 "공개 발행"은 §9-B에서 사용자가 위험을 감수할지 결정해야 한다.

## 3. 목표와 비목표

**목표**: 원고가 승인되면(`job.status = approved`), 사람 개입 없이 활성화된 플랫폼 전부에
업로드되고, 각 결과(발행 URL 또는 실패 stage)가 Telegram으로 온다.

**비목표**
- WordPress, Medium 등 다른 채널 (로드맵상 다음)
- 발행 후 수정/삭제 (별도 스프린트)
- 댓글·통계 (Sprint 6+)
- 네이버 흐름 변경 — 네이버는 반자동 그대로 둔다

## 4. 아키텍처

```
src/config/
  publishTargets.ts          플랫폼별 enabled·일일 상한·blogId 등 (trendSources.ts와 같은 패턴)

src/services/publish/
  convertArticleToHtml.ts     마크다운 부분집합 → 독립 HTML 문자열 (<img> 유지 버전)
                              — convertArticleToNaverHtml.ts를 일반화, 네이버 전용 strip 로직만 분리
  blogger/
    BloggerOAuthClient.ts     refresh token → access token, posts.insert 호출
    setupBloggerAuth.ts       `npm run setup:blogger` — 최초 1회 OAuth 동의 → refresh token 저장
  tistory/
    TistoryPublisher.ts       Playwright: 로그인 확인 → 글쓰기 진입 → 채움 → 발행(또는 비공개 저장)
    setupTistorySession.ts    `npm run setup:tistory` — 프로필에 최초 1회 수동 로그인

src/workflows/publish/
  publishArticleToBlogspot.ts  승인 job 1건 → BloggerOAuthClient → publications 기록
  publishArticleToTistory.ts   승인 job 1건 → TistoryPublisher → publications 기록
  publishApprovedArticles.ts   ★ 트리거: approved인데 아직 안 올라간 job을 훑어 활성 플랫폼으로 fan-out
  publishCli.ts                `npm run job:publish-multi -- <jobId>` 수동 진입점(디버그용)

src/jobs/
  publishPollJob.ts            launchd가 주기 실행 (telegramPollJob.ts와 같은 구조)
```

기존 `publishArticleToNaver.ts`의 계약을 그대로 따른다: job 조회 → `approved` 확인 → 최신
article/이미지 로드 → 멱등성 체크(같은 `article_id + platform`에 진행/완료 row 있으면 skip) →
발행 → `publications` 기록(성공/실패 모두).

## 5. 트리거 — 폴링 job (콜백 인라인 아님)

승인 콜백(`review:confirm`) 안에서 바로 발행하지 않는다. 이유:
- Blogger API는 빠르지만 티스토리 Playwright는 최대 수 분 → Telegram 콜백 응답이 그만큼 멈춘다
- 발행 실패 시 재시도가 어렵다 (콜백은 한 번 눌리면 끝)
- 맥 잠자기 중 죽으면 승인만 되고 발행이 영영 안 된다

대신 `publishPollJob`을 launchd로 주기 실행(`caffeinate -i` 감쌈, 네이버/telegram-poll과 동일).
매 실행:

```
1. article_jobs에서 status='approved' 조회
2. 각 job의 최신 article에 대해, publications를 플랫폼별로 확인
3. 활성 플랫폼 중 아직 성공 기록이 없는 곳으로만 발행
4. 일일 상한(§8) 확인 — 넘으면 이번 job은 건너뛰고 다음 실행 때 재시도
5. 활성 플랫폼 전부 성공 → job.status='published'
6. 결과를 Telegram으로 (성공 URL / 실패 stage)
```

`approved`가 종착이 아니라 대기열이 된다. 재시도·부분 성공·상한 초과가 전부 자연스럽게 처리된다.

## 6. 콘텐츠 변환

`convertArticleToNaverHtml.ts`가 이미 우리 마크다운 부분집합(`##`, `**`, `*`, `[]()`, `-`,
`![]()`)을 HTML로 만든다. 이걸 일반화한다:

- **Blogspot**: `![alt](url)` → `<img src="{supabase 공개 URL}" alt="{alt}">` 그대로. Blogger는
  본문 HTML을 저장만 하고 이미지를 재호스팅하지 않는다 — Supabase Storage 공개 버킷
  (`article-images`)이 영구 공개이므로 문제없다. `<h3>`/`<p>`/`<ul>` 등도 그대로 통과.
- **티스토리**: 네이버와 같은 고민. 티스토리 에디터에는 **기본 HTML 모드**가 있어(툴바 "기본
  모드" ↔ "HTML" 전환) 서식 손실 없이 HTML 문자열을 그대로 넣을 수 있다 — 네이버 SmartEditor의
  clipboard paste보다 신뢰도가 높다. 이미지는 §9-C에서 결정.
- 해시태그: 네이버처럼 본문 끝 "#태그" 텍스트 줄이 그대로 따라간다. 티스토리는 별도 태그 입력란이
  있으므로 Playwright로 채워도 된다(발행 버튼과 무관한 필드라 위험하지 않음).

## 7. Blogspot 인증 — refresh token

1. GCP 프로젝트에서 OAuth 2.0 Client(Desktop app) 생성, Blogger API 사용 설정
2. `npm run setup:blogger` — 로컬 서버로 동의 화면 1회 → `refresh_token` 획득
3. 저장 위치: `.env`의 `BLOGGER_REFRESH_TOKEN` + `BLOGGER_CLIENT_ID`/`BLOGGER_CLIENT_SECRET`
   (`.env`는 이미 gitignore, service-role 키 등과 같은 취급)
4. 런타임에 `refresh_token` → `access_token` 교환(만료 1시간, 자동 갱신)
5. 대상 블로그: `BLOGGER_BLOG_ID` (Blogger 관리 화면 URL 또는 `blogs.getByUrl`로 확인)

스코프는 `https://www.googleapis.com/auth/blogger` 하나면 `posts.insert`에 충분하다.

## 8. 안전장치 (로드맵 §6-3)

- **일일 발행 상한을 코드로 하드 가드** — 설정값이 아니라 상한. `publications`에서 오늘
  `platform`별 `published` 수를 세고 초과 시 발행 안 함. 기본값 제안: 플랫폼당 **하루 2건**
  (티스토리 플랫폼 자체 한도는 15건이지만 저품질 회피가 목적).
- **발행 시각 분산** — 폴링 주기에 랜덤 지터. 승인 직후 정각에 몰아 올리지 않는다.
- **인물 관련 원고는 이미 사람 승인 필수** — `job.status=approved`가 트리거이므로 이 게이트는
  이미 통과된 상태(로드맵 §6-2). 추가 게이트 불필요.
- **티스토리 발행 실패 격리** — 한 플랫폼 실패가 다른 플랫폼 발행을 막지 않는다
  (`runCommunityCollection`의 사이트별 격리와 같은 원칙).
- **멱등성** — 같은 job 재실행 시 이미 성공한 플랫폼은 재발행 안 함.

## 9. 결정 항목 (사용자 승인 필요)

**A. 순서·범위** — Blogspot 먼저 구현·검증 → 그 다음 티스토리. WordPress는 제외. (권장: 그대로)

**B. 티스토리 발행 가시성** — 완전 자동 발행 시 티스토리에 어떻게 올릴지:
  - (B1) **공개 발행** — 진짜 완전 자동. 저품질/스팸 판정 위험을 사용자가 감수.
  - (B2) **비공개로 발행 후 알림** — 글은 실제로 생성(초안 아님)되고 URL이 오지만 비공개.
    사람이 티스토리에서 "공개"로 전환. "업로드까지 자동 + 공개는 사람" 절충안. (권장)
  - (B3) 네이버처럼 임시저장까지만.

**C. 티스토리 이미지 삽입** — (C1) Playwright 파일 업로드(네이버 방식, 티스토리 CDN 재호스팅,
  신뢰도 높음, 느림) vs (C2) HTML 모드에 Supabase 외부 `<img>` URL 그대로(빠름, 티스토리가
  외부 이미지를 계속 서빙해줄지 불확실). (권장: C1)

**D. 대상 블로그** — Blogspot `BLOGGER_BLOG_ID`, 티스토리 블로그 주소/계정. 사용자가 제공.
  카테고리 매핑(내부 entertainment/ott/parenting/living → 각 플랫폼 카테고리) 필요 여부.

**E. 일일 상한값** — 플랫폼당 하루 몇 건. (제안: 2)

**F. GCP OAuth client** — 사용자가 GCP 프로젝트에서 생성·제공할지, 아니면 Claude가 절차를
  단계별로 안내할지.

## 10. 작업 순서 (결정 후)

```
1. convertArticleToHtml.ts — convertArticleToNaverHtml 일반화 + 테스트
2. publishTargets.ts — 설정 스캐폴드 (전부 기본 disabled)
3. BloggerOAuthClient + setup:blogger — 인증 흐름, 사용자가 1회 동의
4. publishArticleToBlogspot.ts + 멱등성/기록 + 단위 테스트(주입 의존성)
5. 실측 1건 — 승인된 실제 job으로 Blogspot에 비공개/드래프트 발행해 형태 확인 (사용자 승인)
6. publishApprovedArticles + publishPollJob + launchd 등록
7. Blogspot 완전 자동 가동 + 며칠 관찰
--- 여기서 티스토리 ---
8. 티스토리 DOM 실측 (네이버 때처럼 setup 세션에서, 발행 버튼은 절대 안 누름)
9. TistoryPublisher.ts — §9-B 결정대로
10. 실측 1건 (사용자 승인) → 가동
```

Blogspot(1~7)까지가 "완전 자동 발행"의 첫 실현이다. 티스토리(8~10)는 실측이 선행돼야 해서
브라우저 있는 환경에서만 진행 가능.

## 11. 이번 스프린트가 끝나면

승인 버튼 한 번으로 원고가 Blogspot에 자동 게시되고(공개), 티스토리에 자동 업로드된다
(§9-B 결정에 따라 공개 또는 비공개). 로드맵 8단계 파이프라인의 S7(발행)이 네이버 반자동 +
2개 채널 완전 자동으로 확장된다. 남는 것은 S8(댓글·통계·대시보드)뿐.
