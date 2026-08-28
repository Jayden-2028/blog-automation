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

## 6. 콘텐츠 채우기 흐름 (2026-08-28 실측 완료 - 셀렉터 확정)

```
1. https://blog.naver.com/{blogId}/postwrite?categoryNo={n} 로 직접 이동
   (프레임셋을 거치지 않고 SmartEditor가 최상위 문서로 바로 뜬다 - §6-2 참고)
2. 제목: .se-component.se-documentTitle .se-title-text 안의 .se-text-paragraph를 클릭 후 타이핑
3. 본문: .se-component.se-text[data-a11y-title="본문"] .se-module-text 안의 같은 패턴으로 타이핑
4. 이미지: 툴바의 .se-toolbar-item-image 클릭 → 열리는 파일 선택 대화상자에
   setInputFiles()로 업로드(images 테이블 URL을 먼저 로컬로 다운로드해야 함)
5. "발행" 버튼([data-click-area="tpb.publish"])을 클릭해 설정 패널을 연다
   (⚠️ 패널을 여는 클릭과 실제 발행 확정은 별개 - 5·6·7단계는 패널이 열려 있는 상태에서
   진행하고, 패널 안의 진짜 확정 버튼은 마지막 8단계에서만, 그것도 "저장" 경로에서는
   아예 누르지 않는다)
6. 태그: 패널 안 #tag-input(placeholder="태그 입력 (최대 30개)")에 하나씩 입력
   (data-click-area="tpb*i.tag")
7. 카테고리/공개설정은 기본값 그대로 둔다 - 카테고리는 이미 URL의 categoryNo로 지정되고,
   기본 공개설정은 "전체공개"(open_public, value=2)로 이미 선택돼 있음을 확인했다
8. "저장"(임시저장) 버튼 [data-click-area="tpb.save"] 클릭
   - 패널 안의 [data-click-area="tpb*i.publish"](data-testid="seOnePublishBtn")는
     **절대 클릭하지 않는다** - 이게 실제 발행 확정 버튼이다
9. 임시저장 후 URL 또는 draft ID를 확보해 publications.published_url에 기록
```

4번(이미지 업로드 상호작용의 정확한 방식)만 아직 라이브로 클릭까지 확인하지 못했다 -
`.se-toolbar-item-image` 버튼의 존재는 정적 DOM에서 확인했지만 클릭 시 파일 선택 대화상자가
바로 뜨는지, 아니면 URL 붙여넣기 등 다른 경로가 먼저 나오는지는 구현 단계에서 실측한다.
최악의 경우 이미지를 본문 맨 끝에 몰아 넣는 것으로 타협할 수 있다(§9-5 결정) - 그래도
"임시저장함에 완성된 형태로 들어간다"는 로드맵의 완료 조건은 충족한다.

### 6-1. 자동화 대상 후보 — 데스크톱 SmartEditor vs 모바일 웹 에디터 (2026-08-28 추가)

§10-1 실측 세션이 사용자의 맥 사용이 어려워 중단되면서, 대안으로 모바일 웹 에디터를 함께
검토했다. `m.blog.naver.com/PostWriteForm.naver?blogId={blogId}`가 실제 존재하는 엔드포인트
임을 확인했다(비로그인 상태로 curl 요청 시 `nid.naver.com` 로그인 화면으로 302 리다이렉트 -
정상 동작). 데스크톱 SmartEditor ONE은 무거운 리치텍스트 iframe 기반이라 자동화가 까다로울
가능성이 큰 반면, 모바일 웹 에디터는 마크업이 더 단순해 오히려 자동화하기 쉬울 수 있다 -
**§10-1 실측 재개 시 둘 다 열어보고 비교해 어느 쪽을 자동화 대상으로 삼을지 정한다.**

⚠️ 짚어야 할 오해: "모바일 에디터를 쓴다"는 게 "사용자가 폰으로 직접 조작한다"는 뜻이
아니다. Playwright는 여전히 맥(또는 서버)에서 실행되고, 모바일 뷰포트/URL을 흉내낼 뿐이다
(Creator Advisor가 400x778 뷰포트로 이미 이 방식을 쓰고 있다 - `CREATOR_ADVISOR_VIEWPORT`).
사용자가 실제 폰으로 로그인 화면을 조작하는 경로는 없다 - `headless:false` 브라우저 창은
맥 화면에 뜨므로, §10-1의 최초 로그인/DOM 실측은 **사용자가 맥 앞에 있을 때만** 진행할 수
있다. 이 제약은 자동화 대상을 모바일 에디터로 바꿔도 그대로 남는다.

### 6-2. 실측으로 확정된 DOM 구조 (2026-08-28)

`npm run setup:naver-publish` + `npm run inspect:publish-layer`로 실제 로그인 세션에서 캡처한
글쓰기 화면 DOM(`.local/dom-snapshots/naver-publish/`, gitignore) 근거.

**중요 발견 1 - 프레임셋 우회**: `https://blog.naver.com/{blogId}` 블로그 홈은 프레임셋
(`#mainFrame` iframe 안에 실제 콘텐츠)이지만, `/postwrite?categoryNo={n}` URL로 **직접**
이동하면 SmartEditor가 프레임 없이 최상위 문서로 바로 로드된다. 자동화는 항상 이 직접 URL을
써야 한다 - 프레임셋을 거치면 `page.content()`가 iframe 내부를 못 잡는 문제가 다시 생긴다.

**중요 발견 2 - 저장/발행 버튼 3개, 절대 혼동 금지**:

| 위치 | 셀렉터 | 의미 |
|---|---|---|
| 상단 툴바 | `[data-click-area="tpb.save"]` | 임시저장 (자동화가 눌러도 되는 유일한 버튼) |
| 상단 툴바 | `[data-click-area="tpb.publish"]` | 발행 설정 **패널을 여는** 버튼 (패널 열기 자체는 발행 확정이 아님) |
| 패널 내부 | `[data-click-area="tpb*i.publish"]` (`data-testid="seOnePublishBtn"`) | 패널 안의 진짜 **발행 확정** 버튼 - 이걸 누르면 실제로 발행된다. 자동화는 이 셀렉터를 코드 어디에서도 클릭하지 않는다 |

**제목/본문 입력**:
- 제목: `.se-component.se-documentTitle[data-a11y-title="제목"]` → 내부
  `.se-module-text.__se-unit.se-title-text` → 실제 타이핑 대상은
  `.se-text-paragraph .__se-node`(빈 상태에서는 `.se-placeholder`가 "제목" 표시)
- 본문: `.se-component.se-text[data-a11y-title="본문"]` → 동일한 `.se-module-text` 패턴

**이미지 툴바**: `.se-toolbar-item-image` (본문 삽입용). 별도로 `se-cover-button-local-image-upload`
/ `se-cover-button-sns-image-upload`가 있는데 이건 제목 영역 "커버 이미지" 기능으로 다른
기능이니 혼동하지 않는다.

**발행 설정 패널 필드** (패널은 정적 DOM에 없다가 `tpb.publish` 클릭 시 렌더링됨):
- 태그: `#tag-input` (placeholder="태그 입력 (최대 30개)", `data-click-area="tpb*i.tag"`)
- 카테고리: `[data-click-area="tpb*i.category"]` 셀렉트 버튼 - URL의 `categoryNo`로 이미
  지정되므로 자동화에서 별도로 건드릴 필요 없음(실측 시 categoryNo=32 → "육아" 자동 표시 확인)
- 공개설정: 라디오 `#open_public`(value=2, "전체공개")이 기본 선택돼 있음 - 별도 조작 불필요
- 발행 시간: 라디오 "현재"(`radio_time1`)가 기본 선택 - 예약 발행 기능은 이번 스프린트 범위 아님

**아직 라이브로 클릭까지 확인 못 한 것**: 이미지 업로드 버튼 클릭 후 실제 상호작용 방식
(파일 선택 대화상자 vs 다른 UI) - `NaverBlogPublisher.ts` 구현 시 실측한다.

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
| 1 | 실측 — ✅ **완료(2026-08-28)**: 최초 로그인 + 데스크톱 SmartEditor DOM 확인, 셀렉터·저장/발행 버튼 구분·발행 설정 패널(태그 등) 확정(`npm run setup:naver-publish` + `npm run inspect:publish-layer`, §6/§6-2 기록). 모바일 웹 에디터(§6-1)는 데스크톱 쪽에서 충분한 셀렉터를 확보해 비교 불필요 판단, 스킵 | Claude + 사용자 | 사용자가 맥 앞에 있을 때 |
| 2 | `naverPublisherConfig.ts` + 프로필 분리 | Claude | 1 |
| 3 | `convertArticleToNaverHtml.ts` + 테스트 | Claude | 1 |
| 4 | `NaverBlogPublisher.ts`(로그인 확인 → 채움 → 임시저장). 이미지 업로드 클릭 상호작용은 여기서 실측 | Claude | 1, 2, 3 |
| 5 | ✅ **완료(2026-08-28)**: `publishArticleToNaver.ts` + `job:publish` CLI + `publications` 기록 (발행 상한 가드는 §8/§9-3 결정에 따라 만들지 않음) | Claude | 4 |
| 6 | ✅ **완료(2026-08-28)**: `notifyPublishReady.ts` | Claude | 5 |
| 7 | ✅ **완료(2026-08-28)**: 실측 검증 + 본문 붙여넣기 버그 발견·수정·재검증 - 상세는 §12/§13/§14 | Claude + 사용자 | 5, 6 |

1번이 이 스프린트의 핵심 관문이다 - Creator Advisor 때 셀렉터를 실측 없이 추측했다면 전부
틀렸을 것이다(`.u_ni_trend_list_box` 같은 이름은 코드를 짜면서 만들어낼 수 있는 값이 아니다).
같은 이유로 SmartEditor도 실측이 먼저다.

## 11. 이번 스프린트가 끝나면

승인된 원고가 버튼 한 번으로 네이버 블로그 임시저장함에 제목·본문·이미지·태그가 채워진 채로
들어가고, Telegram으로 "확인 후 발행하세요" 알림이 온다. 그러면 파이프라인의 마지막 사람 개입
지점(발행 버튼 클릭)만 남는다 - 로드맵의 8단계 파이프라인 중 7단계(발행 직전까지)가 닫힌다.

## 12. §10 item 7 - 1차 실측 결과 (2026-08-28)

**대상**: "맥도날드 감튀 홀더" job(`77e4cc36-...`), `npm run job:publish -- <jobId> --watch`
(headless:false로 직접 지켜보며 실행, `--watch` 플래그 이번에 추가함).

### 확인된 것(✅ 가설이 맞았다)

- **제목 입력**: `.se-title-text` 클릭 후 `page.keyboard.type()` - 정상 반영. 숨겨진
  contenteditable proxy 가설이 맞았다.
- **본문 붙여넣기**: `document.activeElement`에 paste 이벤트 dispatch - 정상 반영("맥도날드",
  "감튀 홀더" 텍스트가 실제 초안에 들어감).
- **이미지 업로드(가장 불확실했던 부분)**: `.se-toolbar-item-image` 클릭 → `filechooser` 이벤트
  → `setInputFiles()` - **실제로 동작했다.** 임시저장 후 초안을 다시 열어보니 첫 번째 이미지가
  NAVER 자체 CDN(`blogfiles.pstatic.net/...`)에 재업로드된 상태로 "대표"(커버) 이미지처럼
  캔버스에 정상 렌더링돼 있었다.
- **임시저장 자체**: `[data-click-area="tpb.save"]` 클릭 후 실제로 "임시저장 글" 목록에 1건이
  생겼다 - 저장 시각(22:26)도 실행 시각과 일치. `save_count_btn__ZTLNa`
  (`[data-click-area="tpb*s.count"]`, `aria-label="임시저장된 글 보기, N개"`)가 이 목록을 여는
  안전한(저장/발행과 무관한) 버튼이라는 것도 이번에 새로 확인했다 - §6-2에 없던 셀렉터라
  `NaverBlogPublisher.ts`에는 아직 안 넣었다(발행 확인용으로만 쓰고 자동화 흐름에는 불필요).

### 확인 못 한 것(⚠️ 아직 미해결)

- **이미지 2·3번째**: 초안을 다시 열었을 때 `<img>` 3개 중 1개만 실제 CDN URL이었고 나머지
  2개는 빈 placeholder(`data:image/svg+xml`)였다 - 아직 렌더링 중이었을 수도, 실제로 안
  들어갔을 수도 있다. 이어서 더 깊이 확인하려던 중 재진입 시 클릭이 막히는 문제(아래)가
  생겨 못 끝냈다.
- **해시태그**: 화면 텍스트에서 "#맥도날드" 문자열을 못 찾았다 - 패널을 열고 태그를 입력한 뒤
  Escape로 닫는 흐름(`fillTags()`)이 실제로 반영됐는지 확인이 안 됐다.
- **재진입 시 클릭 차단**: 임시저장된 초안이 있는 상태에서 글쓰기 화면에 다시 들어가면
  `se-popup-dim se-popup-dim-white`라는 dim 오버레이가 생겨 몇 초간 클릭을 막는다(정확한
  트리거 조건 미확인 - 재현 시도 2회 모두 `[data-click-area="tpb*s.count"]` 클릭이 30초
  타임아웃으로 실패). 실제 화면 텍스트에는 이 오버레이에 대응하는 안내 문구가 안 보였다
  (아마 "이어서 작성하시겠습니까" 류의 확인 dialog가 짧게 떴다 사라지는 것으로 추정) -
  `NaverBlogPublisher.ts`의 저장 흐름 자체에는 영향 없지만(그 흐름은 재진입이 아니라 최초
  진입만 쓴다), 사후 검증/재시도 스크립트를 만들 때는 이 오버레이가 사라질 때까지 기다리는
  로직이 필요하다.

### 별도로 겪은 것 - 계정 세션이 중간에 로그아웃됨

라이브 저장 직후 검증차 자동화 브라우저를 연달아 열었더니 세 번째 접속에서 로그인 화면으로
튕겼다. 사용자가 "동시에 같은 계정으로 다른 글을 작성 중이었다"고 알려줬고, 재로그인 후에는
문제없이 진행됐다 - **네이버 계정을 동시에 다른 세션(폰 앱 등)에서 쓰고 있으면 자동화 세션이
로그아웃될 수 있다**는 뜻으로 보인다(정확한 메커니즘은 미확인). `job:publish`를 실행하기 전에는
다른 곳에서 동시에 같은 계정으로 글을 쓰고 있지 않은지 먼저 확인하는 게 안전하다.

### 결론

핵심 가설(숨겨진 입력 proxy, 이미지 toolbar 업로드, 저장 버튼)은 실사용 조건에서 검증됐다.
이미지 2·3번째와 해시태그는 사용자가 네이버 앱/브라우저로 직접 초안을 열어 육안 확인하는 게
가장 빠르고 안전하다(자동화 재진입은 위 오버레이 문제로 매번 성공한다는 보장이 없다). 확인
후 문제가 있으면(이미지 2장 누락, 태그 미반영) 그 지점만 다시 조사한다.

## 13. 사용자 육안 확인 결과 + 태그 흐름 변경 (2026-08-28)

**확인 결과**: 이미지 3장 전부 정상 삽입됨. 해시태그도 발행 설정 패널의 "태그 편집"란에 15개
전부 정확히 들어가 있었음(사용자가 스크린샷으로 확인).

**결정**: 태그를 발행 설정 패널(`tpb.publish` 클릭 → `#tag-input`)에 직접 입력하는 방식을
**그만 쓰기로 했다.** 이 방식 자체는 동작했지만(§12에서 검증됨), 자동화가 "발행" 버튼과 같은
패널을 열어야 한다는 점에서 실제 발행 버튼에 더 가까이 다가가는 구조였다. 사용자 설명: "원고에
들어간 해시태그가 발행시에 자동 적용되기 때문에" - 즉 본문 텍스트 끝에 "#태그" 형태로 있으면,
사람이 실제로 "발행"을 누르는 순간 네이버가 그 텍스트를 인식해 태그로 자동 반영해준다. 그래서
이제부터는 본문에 이미 있는 해시태그 줄(`runArticleJob.ts`가 붙임)이 paste로 함께 들어가는
것만으로 충분하다 - 자동화는 발행 설정 패널을 아예 열지 않는다.

**변경한 파일**:
- `NaverBlogPublisher.ts` - `fillTags()`/`openPublishPanelButton`/`tagInput` 셀렉터/`"tags"`
  stage/`hashtags` 입력 필드를 전부 제거. `saveDraft()` 흐름이 login → navigate → title →
  body → image → save로 단순해졌다(발행 패널을 아예 안 연다).
- `publishArticleToNaver.ts` - `job.metadata.hashtags`를 더 이상 별도로 뽑아 전달하지 않는다
  (이미 `article.content` 끝에 포함돼 `bodyHtml`로 함께 paste된다).
- 테스트(`testPublishArticleToNaver.ts`) 갱신: `saveDraft` 입력에 `hashtags` 필드가 없는지,
  `bodyHtml`에 해시태그 텍스트가 그대로 남아 있는지로 검증 방식을 바꿈.

이 변경으로 자동화가 클릭하는 버튼이 `tpb.save` 하나로 줄었다 - 발행 패널(`tpb.publish`) 자체를
열지 않으므로, 실제 발행 확정 버튼(`tpb*i.publish`)과의 "거리"도 코드상으로 더 멀어졌다.

## 14. 본문 붙여넣기 버그 발견 + 수정 + 재검증 (2026-08-28)

**발견**: §13에서 이미지/태그를 확인하는 김에 본문도 봐달라고 요청했더니, 사용자가 "이미지
외에는 아무 내용이 없어"라고 확인 - **본문 문단이 통째로 비어 있었다.** §12에서 자동 검사로는
"맥도날드"/"감튀 홀더" 텍스트가 있다고 나왔는데, 그건 **제목**에 이미 그 단어들이 들어 있어서
매칭된 것이었지 실제 본문 문단이 있었던 게 아니었다 - 검증 스크립트의 허점이었다.

**원인**: `focusAndPasteHtml()`이 `document.activeElement`에 합성(synthetic) `ClipboardEvent`를
직접 `dispatchEvent()`하는 방식이었다. SmartEditor(React 기반)의 실제 paste 핸들러가 이런
신뢰되지 않은 이벤트를 무시한 것으로 보인다 - 예외 없이 조용히 아무 일도 안 일어난 것.

**수정**: 실제 OS 클립보드에 HTML을 써넣고(`navigator.clipboard.write()` +
`context.grantPermissions(["clipboard-read","clipboard-write"])`) `Ctrl+V`/`Cmd+V`를
누르는 방식으로 바꿨다 - 브라우저가 "진짜" paste로 인식하므로 사람이 손으로 붙여넣는 것과
동일한 경로를 탄다.

**재검증**: `publishArticleToNaver()`의 멱등성 가드(이미 pending publication 존재) 때문에
같은 job으로는 정상 경로 재실행이 막혀서, `NaverBlogPublisher.saveDraft()`를 직접 호출하는
1회성 스크립트로 재확인했다 - 네이버 초안함에 "[재검증]" 표시가 붙은 두 번째 임시저장 글이
하나 더 생겼다(사용자 사전 승인, 발행은 안 함). **사용자가 브라우저를 직접 지켜보며 본문
문단이 실제로 채워지는 것을 확인했다.** 이제 §10 item 7의 핵심 가설(제목/본문/이미지/저장)이
전부 실사용 조건에서 검증됐다.

**남은 것**: 이 재검증용 두 번째 임시저장 글은 실제 배포용이 아니므로 사용자가 초안함에서
직접 정리해도 된다. "임시저장" 성공 신호(토스트/URL 변화)는 여전히 고정 시간 대기로 대체돼
있다 - 급하지 않으면 다음에 개선한다.
