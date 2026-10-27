# Korea Plain 리브랜딩 (2026-10-28) — 구 The Korea Manual

> 사용자 결정 2026-10-28. 이유: thekoreamanual.com이 같은 이름·같은 주제의 제3자 사이트(2026-06 등록, 운영 중)라 브랜드가
> 충돌한다(`/Users/wooahpapa/blog-automation/TKM-CUSTOM-DOMAIN-2026-10.md` §0). 새 도메인 koreaplain.com 연결과 주소 치환은
> **이번 범위 밖**이다 - 도메인이 붙은 뒤 별도 세션.

## 확정 문구

| 항목 | 값 |
|---|---|
| 이름 | **Korea Plain** |
| 태그라인 | **Korea, in plain English** |
| 설명(메타·블로그 검색 설명·JSON-LD) | **Practical step-by-step guides to Korean transport, apps, errands, and customs — in plain English.** |

"plain"이 "평원·단순한"으로 읽힐 수 있어 태그라인을 제목 옆(헤더 설명)·About·메타 설명·JSON-LD(publisher.slogan)에 반드시 노출한다.
코드 상수: `src/workflows/publish/tkmPostStructure.ts`의 `TKM_BRAND_NAME`·`TKM_BRAND_TAGLINE`·`TKM_BRAND_DESCRIPTION`·`TKM_FORMER_BRAND_NAME`.

## 1. 팀장 Blogger UI 작업표 (API로 못 바꾸는 것)

공개 페이지 실측(2026-10-28 `curl https://thekoreamanual.blogspot.com/`) 기준 현재 값이다.

| # | 위치(Blogger 관리 화면) | 현재 값 | 새 값 | 메모 |
|---|---|---|---|---|
| 1 | 설정 > 기본 > **제목** | The Korea Manual | **Korea Plain** | `<title>`, `og:title`, 헤더 h1, 피드 제목("… - Atom/RSS")이 모두 이 값을 따른다 |
| 2 | 설정 > 기본 > **설명** | Korea, explained step by step. | **Korea, in plain English** | 테마 헤더에서 제목 바로 아래에 나온다(= "제목 옆 태그라인"). 피드 subtitle도 이 값 |
| 3 | 설정 > 메타 태그 > **검색 설명**(블로그 레벨) | Practical step-by-step guides to Korean transport, apps, errands, and customs. | **Practical step-by-step guides to Korean transport, apps, errands, and customs — in plain English.** | 홈의 `meta description`·`og:description`. 글별 검색 설명은 건드리지 않는다 |
| 4 | 레이아웃 > **헤더 가젯**(Header1, 가젯 이름 "The Korea Manual (Header)") | 제목·설명 표시 | 그대로(1·2를 바꾸면 자동 반영). 이미지 헤더로 바꾸지 않는다 | 가젯 이름 표기는 1번을 따라 바뀐다 |
| 5 | 테마 > HTML 편집 | 테마 안에 이름 하드코딩 없음(헤더·title은 `data:blog.title` 계열) | 변경 없음 | 2026-10-27 테마 패치(`TKM_THEME_PATCH_2026-10.md`)에도 이름 문자열 없음 - 1번 반영 뒤 `curl … \| grep -c "Korea Manual"`로 확인 |
| 6 | 파비콘 | Blogger 기본(`/favicon.ico`) | **이번엔 안 바꿈** | 로고가 없다. 도메인 전환 때 함께 정하면 된다(선택) |
| 7 | 소셜 메타(`og:title`·`og:description`·`og:image`) | 블로그 제목·검색 설명에서 자동 생성 | 1·3번으로 자동 반영 | 별도 설정 없음. og:image는 글 대표 이미지 |
| 8 | 레이아웃 > 링크 목록(LinkList1, "All Guides" 등) | 이름 없음 | 변경 없음 | 확인만 |

확인 명령(1~3 반영 뒤):

```bash
curl -s https://thekoreamanual.blogspot.com/ | grep -o "<title>[^<]*</title>\|name='description'[^>]*\|<h1>[^<]*</h1>" ; curl -s https://thekoreamanual.blogspot.com/ | grep -ci "the korea manual"
```

두 번째 숫자가 0이면 테마·설정 쪽 옛 이름이 다 빠진 것이다(주소 `thekoreamanual`은 소문자 붙여쓰기라 세지 않는다).

## 2. 저장소 변경 (코드·프롬프트·문서)

- **사용자에게 보이는 문자열 교체**: 발행 JSON-LD(`buildJsonLdHtml` - author·publisher 이름 Korea Plain, publisher에 slogan·description 추가),
  All Guides 문구(`buildAllGuidesHtml`), 텔레그램 통합 알림 안내(`notifyManuscriptsReady.ts`), 원고 뷰어 제목(`renderManuscriptPage.ts`),
  발행 실패 메시지(`publishArticleToBlogspot.ts`), 번역 프롬프트(`prompts/translation/kscene-ko-en.md` - 매체 소개에 태그라인 + "옛 이름을 쓰지 말 것").
- 주석·워크플로 설명·`.env.example`·style 규격의 "The Korea Manual" → "Korea Plain".
- **바꾸지 않은 것**(운영 영향): 식별자·파일명(`tkmSite.ts`, `TKM_*`, `tkm-related`/`tkm-jsonld` 클래스), 환경변수·시크릿(`KSCENE_*`), 트랙 키 `kscene`,
  텔레그램 봇 사용자명 `@KoreanManualBot`, 호스트 `thekoreamanual.blogspot.com`, 페이지 슬러그 `/p/about-korea-manual.html`,
  이미지 호스트 `korea-manual-images-2026.pages.dev`(Cloudflare Pages 프로젝트 이름 - 바꾸면 기존 글 이미지가 깨진다).
  `tkmPostStructure.ts` 첫머리에 "TKM = Korea Plain(구 The Korea Manual)" 주석.
- 새 발행 경로: 새 글은 `finalizeTkmPost` → `buildJsonLdHtml`로 새 이름이 들어가고, All Guides는 발행 때마다 새 문구로 재생성된다.

## 3. 기존 글·페이지 치환 (`npm run tkm:rebrand`, 워크플로 `tkm-rebrand.yml`)

- 순수 변환 `src/workflows/publish/tkmRebrand.ts`, CLI `tkmRebrandCli.ts`. 기본 dry-run, `--apply --limit=N`, `--target=all|posts|pages`, `--only=`.
- 글: 본문만 patch(posts.patch에 content만). 바뀌는 건 `tkm-jsonld` 블록의 author·publisher뿐 - dateModified 등 다른 칸은 그대로.
- 페이지: pages.patch로 제목·본문. About만 제목 "About Korea Plain" + 맨 위 태그라인 문단 + 첫 문장 "Korea Plain (formerly The Korea Manual) is …".
- 검증 `checkNameOnlyChange`: JSON-LD는 author·publisher 외 칸이 같아야 하고, 나머지 HTML은 `replaceFormerName(전) == 후 - 허용 삽입`(문자 단위).
  통과 못 하면 그 건은 건너뛰고 실패 목록. 적용 뒤 저장본을 다시 읽어 옛 이름 0을 확인. 바꿀 것 없는 글·페이지는 `unchanged`(멱등).
- 2026-10-28 사전 실측(공개 HTML 46개): 글 40편 = JSON-LD 이름 2곳씩(본문 글자 0), About 본문 3 + 제목, Disclaimer 2, Privacy Policy 1, All Guides 1,
  Contact·Editorial Policy 0(변경 없음).

### 실행 결과

(실행 후 단계별로 기록)

## 4. 도메인 전환 때 할 일 — 이번에 건드리지 않음

`TKM-CUSTOM-DOMAIN-2026-10.md` §3 체크리스트 중 **이름과 무관한 항목(1~10: GSC 도메인 속성·서비스 계정·사이트맵, `GSC_SITE_URLS`,
GA4 스트림 URL, 번역 프롬프트의 주소 문구, `publishTargets.ts` 주석·테스트 픽스처의 blogspot URL, `publications` URL 정규화,
고정 페이지의 자기 주소 언급, 월요일 색인 점검)은 하나도 건드리지 않았다.** 호스트·슬러그·이미지 호스트도 그대로다.
§3-11(B안 리브랜딩 항목: 블로그 제목·설명, 번역 프롬프트 브랜드명, 시드 자기 언급, 글 본문 문구)이 이번 작업이다 - 시드
(`ksceneSeeds.ts`)에는 주석 한 줄 말고 자기 언급이 없었다.

## 5. 의도적으로 남긴 "The Korea Manual"

- About 페이지 첫 문장의 "(formerly The Korea Manual)" - 기존 독자·외부 링크 연속성.
- 코드 상수 `TKM_FORMER_BRAND_NAME`·치환 정규식·테스트 픽스처(옛 이름을 입력으로 쓴다).
- 번역 프롬프트의 "옛 이름을 쓰지 말 것" 지시와 머리 주석.
- 역사 기록 문서(`CURRENT_STATE.md`의 날짜별 절 제목, `PROGRESS.md`, `TKM-CUSTOM-DOMAIN-2026-10.md` 등) - 작성 당시 이름. 제목에는 "현재 이름" 주석을 달았다.
- 블로그 제목·설명·피드 제목 - §1 UI 작업 전까지.
