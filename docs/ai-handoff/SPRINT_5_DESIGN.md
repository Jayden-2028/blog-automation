# Sprint 5 설계 — 다채널 발행 (티스토리 반자동 + Blogspot 완전자동, OSMU)

작성일: 2026-08-30 · 상태: **설계 초안, 결정·정보 대기**(§9, §10) · 브랜치 `claude/multi-platform-publish`

## 1. 목표 (2026-08-30 사용자 확정)

승인된 네이버 원고 1건을 기준으로:

| 채널 | 발행 방식 | 원고 |
|---|---|---|
| 네이버 | 반자동 (기존, Sprint 4) — 임시저장까지 자동, 발행 버튼은 사람 | 기준 원고 |
| **티스토리** | **반자동** — 임시저장까지 자동, 발행 버튼은 사람 (네이버와 동일) | OSMU 배리에이션 |
| **Blogspot** | **완전 자동** — 업로드 + 발행(공개)까지 무인 | OSMU 배리에이션 |

**OSMU(One Source Multi Use)**: 네이버 원고를 소스로, 티스토리·Blogspot 각각의 검색 상위노출과
SEO를 충족하는 배리에이션 원고를 생성한다. 단순 서식 변환이 아니라 **의미 있는 재작성**이다 —
같은 사람이 운영하는 서로 다른 도메인에 거의 같은 글이 올라가면 한쪽이 중복 콘텐츠로 걸러진다.

이미지: 네이버 원고와 동일하게 OpenAI API(`gpt-image-1`) + Gemini API. 네이버 원고 이미지 재사용
가능(기본), 채널별 재생성도 옵션.

## 2. 두 플랫폼의 접근 경로

| | Blogspot (Blogger) | 티스토리 |
|---|---|---|
| 공식 API | **Blogger API v3 정상 운영** (`posts.insert`, OAuth 2.0) | **없음. Open API 2024-02 완전 종료** |
| 자동화 | HTTPS API 호출 1건 → 완전 자동 발행 안전 | Playwright 브라우저 자동화(네이버와 동일) |
| 인증 | GCP OAuth client + refresh token (최초 1회 동의, §8) | 로그인된 persistent 프로필 (네이버 방식 재사용) |
| 이미지 | 본문 HTML 외부 `<img src>` 그대로 (Supabase 공개 URL) | Playwright 파일 업로드 (네이버 방식) |

출처: [Blogger API v3 posts.insert](https://developers.google.com/blogger/docs/3.0/reference/posts/insert) ·
[티스토리 Open API 종료](https://tistory.github.io/document-tistory-apis/)

## 3. OSMU 배리에이션 — SEO 템플릿

### 3-1. 공통 SEO 원칙 (조사 기반, 2025~2026)

두 채널 모두 사실상 **구글 검색이 주 유입**이다(티스토리도 다음보다 구글 인덱싱 비중이 크다).
그래서 본문 구조 템플릿은 하나로 통일하고, 메타데이터만 채널별로 다르게 채운다.

- **제목**: 핵심 키워드를 앞쪽에, 짧고 명확하게. 채널마다 표현을 바꿔 자기 채널끼리 완전 일치를 피함
- **첫 문단 100자 안에 핵심 키워드** 반드시 포함
- **H2/H3 소제목 계층**을 명확히. 소제목은 질문형/How-to형(검색 쿼리와 매칭 + 스니펫 노출 유리)
- **FAQ 블록**(끝부분 3~5문답) — 구글 featured snippet / "People also ask" 대응
- **요약 문단**(끝) — 핵심 재진술
- **이미지 alt 텍스트에 키워드**, 파일명도 키워드 기반(현재 UUID → 개선 필요, §7)
- **본문 내부 링크** 1~2개(같은 블로그 관련 글) — 초기엔 생략 가능
- **메타 설명(search description)**: 키워드 + 요점, 155자 내. 랭킹엔 영향 없지만 클릭률에 영향

출처: [티스토리 SEO 전략](https://jehovahrapha-nissi.com/entry/티스토리-검색-노출SEO-강화-전략-콘텐츠-구조-링크) ·
[2025 구글 SEO 가이드](https://blog.medianavi.kr/2025-08-11-Google-SEO-Guide-2025/) ·
[Blogger SEO tips](https://www.pitiya.com/blogger-seo.html)

### 3-2. 채널별 메타데이터

| 필드 | 티스토리 | Blogspot |
|---|---|---|
| 슬러그(permalink) | 숫자 자동(티스토리 제약) 또는 문자열 지정 | **영문 kebab-case 직접 지정** (날짜·숫자 금지) |
| 검색 설명 | 글쓰기 "설명" 필드 | 포스트 "검색 설명(Search Description)" 필드 |
| 분류 | 태그(자유) + 카테고리 | 라벨(Label) — 단, 라벨 남발 금지(중복 콘텐츠 페이지 생성) |
| 카테고리 매핑 | 내부 entertainment/ott/parenting/living → 각 채널 카테고리 (§10-D) | 라벨로 대체 |

### 3-3. 배리에이션 생성

`runHeadlessClaude`(`claude -p`)로 1콜, 네이버 원고 집필과 같은 경로. 입력 = 승인된 네이버
원고 + 대상 채널 + SEO 템플릿 지침. 출력(채널별):

```
title:            (재작성된 제목)
searchDescription: (155자 내)
slug:             (Blogspot만; 영문 kebab)
tags:             (5~10개)
body:             (마크다운 부분집합 — ##, **, -, ![]() ; FAQ·요약 포함)
```

`moai-marketer:content-blog`(SEO 블로그) + `moai-writer:korean-humanize`(AI 티 제거) 스킬을
그대로 재사용한다. **팩트·수치·날짜·인용은 네이버 원고에서 100% 보존**(재작성은 표현만).

## 4. 아키텍처

```
src/config/
  publishTargets.ts           채널별 enabled·일일상한·blogId·카테고리매핑 (trendSources.ts 패턴)

src/workflows/writing/
  generateArticleVariant.ts   승인 원고 → 채널별 배리에이션 1건 (claude -p, §3-3)

src/services/publish/
  convertArticleToHtml.ts     마크다운 부분집합 → 독립 HTML (<img> 유지) — Naver 변환기 일반화
  blogger/
    BloggerOAuthClient.ts     refresh token → access token, posts.insert
    setupBloggerAuth.ts       npm run setup:blogger — 최초 1회 OAuth 동의
  tistory/
    TistoryPublisher.ts       Playwright: 로그인확인 → 글쓰기 → HTML모드 붙여넣기 → 이미지 업로드
                              → 태그 → "임시저장"만 (발행 버튼 안 누름)
    setupTistorySession.ts    npm run setup:tistory — 프로필에 최초 1회 수동 로그인
    inspectTistoryEditor.ts   DOM 실측 전용(발행 버튼 절대 클릭 안 함) — Naver inspect와 동일

src/workflows/publish/
  publishArticleToBlogspot.ts  승인 job → 배리에이션 로드/생성 → Blogger API → publications 기록
  publishArticleToTistory.ts   승인 job → 배리에이션 로드/생성 → TistoryPublisher → publications 기록
  publishApprovedArticles.ts   ★ 폴링: approved인데 미발행인 job을 활성 채널로 fan-out
  notifyMultiPublish.ts        채널별 결과 알림 (Blogspot=발행완료 URL / 티스토리=임시저장 URL)

src/jobs/
  publishPollJob.ts            launchd 주기 실행 (telegramPollJob.ts 구조 + caffeinate)
```

## 5. 트리거 — 폴링 job

승인 콜백 안에서 발행하지 않는다(티스토리 Playwright가 수 분 → 콜백 멈춤, 재시도 불가,
잠자기 중 죽으면 발행 유실). 대신 `publishPollJob`을 launchd로 주기 실행:

```
1. article_jobs에서 status='approved' 조회
2. 각 job의 최신 네이버 원고 기준, publications를 채널별로 확인
3. 활성 채널 중 아직 성공 기록 없는 곳:
   a. 배리에이션 원고 없으면 generateArticleVariant로 생성(1회, 저장)
   b. 일일 상한(§6) 확인 — 넘으면 이번엔 건너뛰고 다음 실행 때 재시도
   c. Blogspot: 발행(공개) / 티스토리: 임시저장
4. publications 기록 (성공 URL / 실패 stage)
5. Blogspot 성공 + 티스토리 임시저장 완료 → job.status='published'
   (네이버·티스토리는 "임시저장까지"가 이 파이프라인의 완료 정의)
6. Telegram 알림
```

`approved`가 종착이 아니라 **발행 대기열**이 된다. 재시도·부분성공·상한초과가 자연 처리된다.

## 6. 안전장치

- **일일 발행 상한을 코드로 하드 가드** — `publications`에서 오늘 채널별 수를 세어 초과 시 발행
  안 함. 제안: 채널당 하루 **2건**(티스토리 플랫폼 한도는 15건이나 저품질 회피 목적).
- **발행 시각 분산** — 폴링 주기 + 랜덤 지터. 승인 직후 정각에 몰아 올리지 않음.
- **채널 실패 격리** — 한 채널 실패가 다른 채널을 막지 않음.
- **멱등성** — 같은 job 재실행 시 이미 성공한 채널은 재발행 안 함(`article_id + platform`로 확인).
- **인물 원고 사람 승인** — `approved`가 트리거이므로 이미 통과된 상태(로드맵 §6-2). 추가 게이트 불필요.
- **배리에이션 팩트 보존** — 재작성 후 `articleReviewChecks`(팩트/법적/광고/품질)를 배리에이션에도
  1회 돌려 결과를 알림에 표시(네이버 원고와 동일 방식, 차단 아님).

## 7. 배리에이션 원고 저장 — 결정 필요 (§10-A)

옵션:
- **(A1) `articles`에 `platform` 컬럼 추가** (nullable, null=네이버 기준). 배리에이션 = 새 row.
  `listArticlesByJobId`가 이미 여러 row를 다룸. migration 1줄. **권장.**
- (A2) `article_jobs.metadata.variants[platform]`에 JSON. migration 없음. 단 본문이 커서 metadata가
  비대해짐, 조회·인덱싱 불리.

이미지 파일명도 함께 개선: 현재 Supabase Storage 키가 UUID → `{키워드-슬러그}-{n}.png`로 바꾸면
alt와 함께 이미지 SEO에 기여(§3-1). 별도 작은 작업.

## 8. GCP OAuth — 이게 뭔가 (Blogspot 발행에 필요)

**한 줄**: 우리 스크립트가 "당신 대신, 당신의 Blogspot에만" 글을 올릴 수 있게 구글이 발급하는
열쇠를 만드는 절차다. 무료.

**용어**
- **GCP(Google Cloud Platform)**: 구글의 개발자 콘솔(console.cloud.google.com). 계정만 있으면 됨.
- **프로젝트**: GCP 안에서 기능을 묶는 폴더. "blog-automation" 하나 만들면 됨.
- **Blogger API 사용 설정**: 그 프로젝트에서 Blogger 기능을 켜는 스위치.
- **OAuth 클라이언트 ID(Desktop app)**: "이 앱이 구글 로그인으로 권한을 받겠다"는 신분증.
  만들면 **Client ID**와 **Client Secret** 두 문자열이 나온다.
- **OAuth 동의**: `npm run setup:blogger` 실행 → 브라우저에 구글 "허용하시겠습니까?" 화면 →
  "허용" 클릭 → 스크립트가 **refresh token**(장기 열쇠)을 받아 `.env`에 저장.
- 이후 스크립트는 refresh token으로 1시간짜리 access token을 자동 발급해 계속 씀. 권한 회수는
  구글 계정 보안 설정에서 언제든 가능.

**사용자가 할 일** (§10-C에 체크리스트로 다시 정리):
1. console.cloud.google.com 접속 → 프로젝트 생성
2. "API 및 서비스 → 라이브러리"에서 **Blogger API** 검색 → 사용 설정
3. "API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 데스크톱 앱"
4. 나온 **Client ID / Client Secret**를 Claude에게 전달
5. `npm run setup:blogger` 실행하고 브라우저에서 "허용" 클릭 (Claude가 안내)

## 9. 확보된 정보 (2026-08-30 사용자 제공)

- 티스토리 주소: `https://wooahpapa.tistory.com/`
- Blogspot 계정: `bjkim2028@gmail.com` (blog ID는 §10-B에서 확인 — Blogger 관리화면 URL의 숫자,
  또는 `blogs.getByUrl`로 조회)

## 10. 결정·정보 요청

**A. 배리에이션 저장** — A1(`articles.platform` 컬럼, migration 1줄) vs A2(metadata JSON). 권장 A1.

**B. Blogspot blog ID** — Blogger(blogger.com) 로그인 → 해당 블로그 관리화면 진입 → 주소창 URL의
`blogID=` 뒤 숫자(19자리쯤). 또는 블로그 공개 주소(`xxx.blogspot.com`)를 알려주면 API로 조회 가능.

**C. GCP OAuth 진행** — 사용자가 §8 1~4를 직접 하고 Client ID/Secret 전달 vs Claude가 화면 캡처
받아가며 단계별 동행. (Claude는 GCP 콘솔에 로그인 못 하므로 클릭은 사용자 몫)

**D. 카테고리 매핑** — 티스토리 `wooahpapa.tistory.com`의 카테고리 목록, Blogspot 라벨 규칙.
내부 4분류(entertainment/ott/parenting/living)를 각 채널 어디에 넣을지. (없으면 전부 기본 카테고리 +
태그로만)

**E. 일일 상한값** — 채널당 하루 몇 건. 제안 2.

**F. 티스토리 발행 가시성** — 임시저장까지만(네이버와 동일, 권장) 확정. 이후 티스토리 앱에서
사람이 "발행" 클릭.

**G. Blogspot 발행 시 초기 노출** — 바로 공개 vs 첫 며칠은 비공개로 올려 형태 확인 후 공개.

## 11. 작업 순서 (결정 후)

```
1. convertArticleToHtml.ts (Naver 변환기 일반화) + 테스트
2. publishTargets.ts 설정 스캐폴드 (전부 기본 disabled)
3. generateArticleVariant.ts + SEO 템플릿 프롬프트 + 테스트(주입)
4. (A1이면) articles.platform 컬럼 migration — 사용자 승인
--- Blogspot ---
5. BloggerOAuthClient + setup:blogger — 사용자 OAuth 동의 1회
6. publishArticleToBlogspot + 멱등성/기록 + 단위 테스트
7. 실측 1건 — 승인 job으로 Blogspot에 비공개 발행해 형태 확인 (사용자 승인)
8. publishApprovedArticles + publishPollJob + launchd — Blogspot 완전자동 가동 + 관찰
--- 티스토리 ---
9. 티스토리 에디터 DOM 실측 (setup 세션, 발행 버튼 안 누름)
10. TistoryPublisher (HTML 모드 붙여넣기 + 이미지 업로드 + 태그 + 임시저장)
11. publishArticleToTistory + 실측 1건 (사용자 승인) → 가동
```

Blogspot(1~8)이 이 프로젝트 첫 "완전 자동 발행"이다. 티스토리(9~11)는 브라우저 실측이 선행돼야
해서 맥에서만 진행.

## 12. 끝나면

승인 버튼 한 번으로: 네이버 임시저장(기존) + 티스토리 임시저장 + Blogspot 공개 발행. 세 채널
모두 채널별 SEO 배리에이션 원고. 로드맵 S7(발행)이 사실상 완성되고, 남는 건 S8(댓글·통계).
