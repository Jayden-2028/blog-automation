# Sprint 4 설계 — 네이버 블로그 반자동 발행

작성일: 2026-08-28 · 상태: **승인 완료**(결정 항목 6건, §9) · 구현 진행 중

## 1. 배경

Sprint 3까지 완성된 산출물이 있다: 승인된 원고(`article.status = "approved"`) + 제목 +
해시태그 15개 + 본문에 삽입된 실사 이미지 2~3장. 이걸 네이버 블로그에 실제로 올리는 마지막
구간이 없다.

로드맵(§Sprint 4)과 `CLAUDE.md`가 이미 방향을 정해뒀다: **완전 자동 발행은 하지 않는다.**
네이버 블로그 글쓰기 공식 API는 2020년에 종료됐고, 남은 방법은 브라우저 자동화(Playwright)뿐이다.
브라우저로 실제 "발행" 버튼까지 누르는 완전 무인화는 계정 저품질/제재 위험이 있고, `CLAUDE.md`가
"Telegram/Kakao 등 외부 메시지 발송"과 나란히 "production 배포"급 위험으로 다룬다. 그래서
**임시저장까지만 자동화하고, 발행 버튼은 사람이 직접 누른다.**

## 2. 목표와 비목표

**목표**: 승인된 원고 1건을 사람이 트리거하면, 네이버 블로그 글쓰기 화면에 제목·본문·이미지·
해시태그가 채워진 상태로 임시저장되고, 그 결과(임시저장함 링크)가 Telegram으로 온다.

**비목표**:
- 발행 버튼 클릭 — 사람이 임시저장함에서 직접 확인 후 누른다
- 댓글/스팸 관리, 통계 수집 — Sprint 5+
- 티스토리·워드프레스 등 다른 플랫폼 — 로드맵상 네이버 다음은 워드프레스/블로그스팟(기술적으로
  더 쉬움)이지 티스토리가 아니다. 이번 스프린트는 네이버만 다룬다

## 3. 왜 이게 기술적으로 제일 위험한 스프린트인가

Sprint 1~3의 자동화는 전부 API 호출(NAVER 검색 API, Supabase, Telegram, OpenAI)이거나
읽기 전용 크롤링(Creator Advisor)이었다. 이번은 처음으로 **사람 계정으로 실제 쓰기 작업을
브라우저에서 수행**한다. 세 가지가 새로운 위험이다.

1. **SmartEditor 셀렉터를 아직 모른다.** Creator Advisor 때도 정확한 셀렉터
   (`.u_ni_trend_list_box` 등)는 설계 단계가 아니라 실제로 Playwright를 열어 DOM을 본 뒤에야
   확정됐다(`debugCreatorAdvisor.ts`의 `--inspect` 모드가 그 흔적이다). SmartEditor도 마찬가지로
   **구현 착수 시 실측이 먼저**고, 이 설계문의 셀렉터 관련 내용은 전부 가설이다.
2. **이미지 삽입 방식이 불확실하다.** SmartEditor의 사진 삽입은 보통 로컬 파일 업로드(파일
   선택 대화상자 또는 드래그앤드롭)만 지원하고 URL 직접 삽입은 안 되는 경우가 많다. 우리
   이미지는 이미 Supabase Storage 공개 URL로 있으므로, 업로드하려면 **다시 로컬로 내려받은 뒤
   파일 입력(input[type=file])에 넣어야 할 가능성이 높다** - Playwright의 `setInputFiles()`가
   이 패턴에 잘 맞는다.
3. **서식 있는 본문 붙여넣기가 불확실하다.** 본문을 한 글자씩 타이핑하면 느리고(수천 자) 부자연
   스러운 타이핑 패턴이 매크로 탐지에 걸릴 수 있다. 클립보드에 HTML을 넣고 붙여넣기
   (`Ctrl+V`)하는 방식이 실측 없이는 서식(소제목/굵게/목록)이 얼마나 보존되는지 알 수 없다.

**이 셋 다 설계 단계에서 확정할 수 없다.** 이 문서는 접근 방식과 안전장치를 정하고, 정확한
구현은 §10 작업 순서의 1번(실측)이 먼저 끝난 뒤 이어진다.

## 4. 아키텍처

```
src/services/publish/
  naverPublisherConfig.ts     설정(blogId, profileDir, 발행 상한 등) - creatorAdvisor.ts와 같은 패턴
  NaverBlogPublisher.ts       Playwright 오케스트레이션(로그인 확인 → 글쓰기 진입 → 채움 → 임시저장)
  convertArticleToNaverHtml.ts 우리 마크다운(##, **, -, ![]()) → SmartEditor에 붙여넣을 HTML

src/workflows/publish/
  publishArticleToNaver.ts    승인된 job 1건을 받아 NaverBlogPublisher를 호출하고 publications에 기록
  publishArticleCli.ts        `npm run job:publish -- <jobId>` 수동 진입점
  notifyPublishReady.ts       임시저장 완료/실패를 Telegram으로 알림
```

`convertArticleToNaverHtml.ts`는 `markdownToTelegraphNodes.ts`와 원칙이 같다 - 우리 원고가
쓰는 마크다운 부분집합(##, \*\*, -, ![]())만 정확히 다루면 되고 범용 마크다운 파서는 필요
없다. 다만 출력이 Telegraph의 Node\[\] 형식이 아니라 **HTML 문자열**이어야 한다(클립보드
붙여넣기용). 새 모듈로 분리하는 이유: 대상 형식이 다르고, SmartEditor가 실제로 어떤 태그를
받아들이는지는 실측 전까지 모르므로 Telegraph 변환 로직과 얽으면 안 된다.

## 5. 로그인 세션 — 프로필을 분리한다

로드맵 §6-7이 이미 정해뒀다: **쓰기 세션은 읽기(Creator Advisor) 세션과 다른 프로필을 쓴다.**
같은 계정이어도 디렉터리를 분리한다(`.local/naver-publish-profile/` 신설, Creator Advisor의
`.local/creator-advisor-profile/`과 별개). 크롤링 세션이 오염되거나, 반대로 발행 세션이
크롤링 중 상태 변화의 영향을 받는 걸 막는다.

로그인 상태 확인은 Creator Advisor의 3단계 패턴(`debugCreatorAdvisor.ts`)을 재사용한다:

```
naverLoginRequired    nid.naver.com에 머묾 - 사람이 최초 1회 수동 로그인 필요
publishReady          글쓰기 화면(PostWriteForm.naver 등)에 정상 도달
```

Creator Advisor보다 상태가 하나 적은 이유: 블로그 선택/서비스 이용 동의 같은 중간 단계가
없다(글쓰기는 로그인만 되면 바로 접근 가능하다고 가정 - 실측 필요).

## 6. 콘텐츠 채우기 흐름 (가설 - 실측 전까지 확정 아님)

```
1. https://blog.naver.com/{blogId}?Redirect=Write 로 이동(또는 실측으로 정확한 글쓰기 URL 확인)
2. 제목 입력란에 article.title 입력
3. 본문 영역에 변환된 HTML을 클립보드 붙여넣기로 삽입
4. 이미지: images 테이블의 URL을 하나씩 다운로드 → setInputFiles()로 업로드 → 본문 내
   올바른 위치에 배치(정확한 위치 제어가 안 되면 최소한 "본문에 들어있기"까지는 보장한다 -
   완벽한 위치 재현은 v2 과제로 미룬다)
5. 태그 입력란에 job.metadata.hashtags를 하나씩 입력(네이버 태그는 보통 "#" 없이 쉼표/엔터 구분)
6. "저장"(임시저장) 버튼 클릭 - "발행" 버튼과 다른 버튼임을 셀렉터로 명확히 구분
7. 임시저장함 URL 또는 draft ID를 확보해 publications.published_url에 기록
```

4번(이미지 위치)이 가장 불확실하다. 최악의 경우 이미지를 본문 맨 끝에 몰아 넣는 것으로
타협할 수 있다 - 그래도 "임시저장함에 완성된 형태로 들어간다"는 로드맵의 완료 조건은
충족한다(위치가 완벽하지 않을 뿐 내용은 다 있다).

## 7. 트리거 — 여전히 수동이다

`CLAUDE.md`와 로드맵 결정("반자동 — 임시저장까지만 자동, 발행 버튼은 사람")을 그대로 따른다.
발행도 지금까지의 write/research 체크포인트와 같은 패턴을 쓴다:

```
npm run job:publish -- <jobId>
```

또는 승인(confirm) 완료 알림에 버튼을 하나 더 붙일 수 있다 - `[📤 임시저장 시작]`
(`publish:start:<jobId>` 콜백). 이건 §9-6에서 결정한다. CLI만 먼저 만들고 버튼은 안정화된
뒤 추가하는 것도 방법이다(Sprint 2에서 조사 체크포인트를 CLI로 먼저 만들고 나중에 버튼을
붙인 전례가 있다).

## 8. 안전장치

- **발행량 상한 — 코드 가드는 만들지 않기로 결정**(2026-08-28, §9-3): 로드맵 §6-3(저품질
  판정 위험)이 하루 1~2건 상한을 코드로 강제할 것을 권고했으나, 사용자가 "제한 없음"을
  명시적으로 선택했다. ⚠️ 이 위험은 여기 다시 적어둔다 - AI 대량 생산은 네이버 C-Rank/DIA+
  관점에서 저품질로 분류될 수 있고, 한 번 걸리면 계정 전체가 죽을 수 있다(로드맵 §6-3).
  트리거 자체가 여전히 수동(§7, `job:publish`를 사람이 한 건씩 실행)이므로 무제한 폭주는
  구조적으로 어렵지만, 하루에 여러 건을 연달아 트리거하는 것을 막는 장치는 없다는 뜻이다.
  `publications` 테이블에 발행 이력은 그대로 남으므로, 나중에 상한이 필요하다고 판단되면
  과거 데이터를 보고 값을 정할 수 있다(코드 자체는 최소 변경으로 다시 넣을 수 있게 설계한다).
- **실패 처리**: 임시저장 중 어느 단계에서든 실패하면 `publications.status = 'failed'`로
  기록하고 Telegram에 실패 단계(로그인/본문/이미지/저장)를 구체적으로 알린다 - Sprint 0에서
  "조용히 죽는 job"을 겪은 뒤로 이 프로젝트의 원칙이다.
- **재시도 멱등성**: 같은 job으로 `job:publish`를 두 번 실행하면 임시저장 초안이 중복 생성될
  수 있다. `publications`에 이미 `pending`/`published` row가 있으면 재실행을 막고 기존 기록을
  보여준다(선택 루프의 unique index 패턴과 같은 원칙 - 중복 클릭/재실행이 중복 산출물을
  만들면 안 된다).
- **발행 버튼 자체를 절대 누르지 않는다**: 이건 안전장치라기보다 이번 스프린트의 정의 자체다.
  "저장" 셀렉터와 "발행" 셀렉터를 혼동하지 않도록 실측 단계에서 반드시 스크린샷으로 확인하고
  주석에 남긴다.

## 9. 결정 상태 (전부 승인 완료, 2026-08-28)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 트리거 방식(§7) | ✅ **CLI만 먼저** (`npm run job:publish -- <jobId>`). 안정화 후 Telegram 버튼 추가 검토 |
| 2 | 발행 대상 블로그 | ✅ `CREATOR_ADVISOR_BLOG_ID`와 **같은 블로그** - 별도 설정 불필요, 그대로 재사용 |
| 3 | 일일 발행 상한 | ✅ **코드 가드 없음**(§8에 위험 재기록 - 사용자가 명시적으로 선택) |
| 4 | 쓰기 세션 최초 로그인 | ✅ **지금 진행** - 이 세션에서 바로 새 프로필로 수동 로그인 |
| 5 | 이미지 위치 타협안(§6-4) | ✅ **허용** - 섹션별 위치 재현이 안 되면 본문 끝에 몰아넣는 것으로 타협해도 완료로 본다 |
| 6 | 실측 단계 진행 방식 | ✅ **`headless: false`로 사용자가 지켜보는 가운데** 진행(Creator Advisor 때와 동일 패턴) |

## 10. 작업 순서

| # | 작업 | 담당 | 선행 |
|---|---|---|---|
| 1 | 실측: SmartEditor 글쓰기 URL·셀렉터·이미지 업로드 방식·저장/발행 버튼 구분 확인(`debug:naver-publish` 스크립트, `--inspect` 모드) | Claude + 사용자 | - |
| 2 | `naverPublisherConfig.ts` + 프로필 분리 | Claude | 1 |
| 3 | `convertArticleToNaverHtml.ts` + 테스트 | Claude | 1 |
| 4 | `NaverBlogPublisher.ts`(로그인 확인 → 채움 → 임시저장) | Claude | 1, 2, 3 |
| 5 | `publishArticleToNaver.ts` + `job:publish` CLI + `publications` 기록 + 발행 상한 가드 | Claude | 4 |
| 6 | `notifyPublishReady.ts` | Claude | 5 |
| 7 | 실측 1건 검증(사용자 승인 후 실제 임시저장 1회) | Claude + 사용자 | 5, 6 |

1번이 이 스프린트의 핵심 관문이다 - Creator Advisor 때 셀렉터를 실측 없이 추측했다면 전부
틀렸을 것이다(`.u_ni_trend_list_box` 같은 이름은 코드를 짜면서 만들어낼 수 있는 값이 아니다).
같은 이유로 SmartEditor도 실측이 먼저다.

## 11. 이번 스프린트가 끝나면

승인된 원고가 버튼 한 번으로 네이버 블로그 임시저장함에 제목·본문·이미지·태그가 채워진 채로
들어가고, Telegram으로 "확인 후 발행하세요" 알림이 온다. 그러면 파이프라인의 마지막 사람 개입
지점(발행 버튼 클릭)만 남는다 - 로드맵의 8단계 파이프라인 중 7단계(발행 직전까지)가 닫힌다.
