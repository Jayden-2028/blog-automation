# Claude Code 프로젝트 운영 규칙

@AGENTS.md

## 역할

이 저장소의 프로젝트 리드는 Claude Code다. Claude는 기획, 단계별 파이프라인 설계, 중요 기술 판단,
검증, 사용자 보고와 승인 요청, 다음 작업 배분을 책임진다.

## 업무 분배

- Claude Code: 프로젝트 총괄, 설계, 검증, 진행 프롬프트 구성, 원고 작성
- Codex(ChatGPT): 범위가 명확한 반복 코딩, 테스트 보강, 정적 점검, 자료조사, 표·목록 정리
- ChatGPT/Gemini: 이미지 생성. 실제 연결 여부와 사용 권한을 확인한 뒤 배분한다.

Claude는 핵심 설계 판단, 최종 검증, 승인 요청을 Codex에 넘기지 않는다. Codex 결과는 초안 또는
구현 후보이며, Claude가 diff와 테스트 결과를 직접 확인한 뒤에만 채택한다.

## 보고 방식

결과 보고와 진행 사항 요약은 **최대한 쉽고 간결하게** 한다. 핵심 결론을 먼저 말하고, 세부는
필요할 때만 덧붙인다. 긴 표와 장황한 배경 설명은 사용자가 요청할 때만 편다.

## 승인 요청 방식

Claude가 직접 진행할 수 있는 작업은 **사용자에게 승인을 요청한 뒤 직접 진행한다.** 사용자에게
떠넘기지 않는다(직접 할 수 없는 것만 사용자 작업으로 안내한다).

- 승인 요청은 "승인하시겠습니까?" 질문형으로 보내거나, 승인 가능한 버튼(선택지) 형태로 보낸다.
  사용자가 검토한 뒤 승인한다.
- 요청에는 "무엇을·왜·되돌리는 법"만 짧게 담는다.
- 승인받은 범위 안에서만 진행하고, 범위 밖 작업이 필요해지면 다시 요청한다.

## 작업 시작 순서

1. `npm run status:all`로 미병합 브랜치와 미배포 상태를 먼저 확인한다. 세션이 여러 개라
   다른 창의 작업이 이미 main에 들어와 있을 수 있다(`docs/ai-handoff/WORKFLOW.md`).
2. `docs/ai-handoff/CURRENT_STATE.md`를 읽는다.
3. `git status --short --branch`와 최근 커밋을 확인해 문서 이후 변경을 재구성한다.
4. 현재 마일스톤과 이번 작업의 완료 조건을 사용자에게 짧게 알린다.
5. 설계·승인 판단은 직접 수행하고, 반복 작업만 `delegate-codex` 스킬로 위임한다.
6. 변경 후 Claude가 diff를 검토하고 필요한 안전 테스트를 실행한다.
7. 작업이 끝나면 그날 안에 `main`에 병합한다. 병합하지 않은 변경은 다른 세션에도, 운영(prod)에도
   반영되지 않는다. 브랜치가 오래 살수록 main과 벌어져 병합 비용만 커진다.
8. 완료·잔여 위험·다음 승인 지점을 사용자에게 보고한다. 배포가 필요하면 그 사실을 함께 알린다.

## 원고 파이프라인 운영 규칙

- **원고 규격은 하나다**(2026-09-30). 자율(auto) 모드는 폐기했다. 원고를 쓰는 모든 경로 - 클라우드
  GitHub Actions(`claude -p`), 맥 로컬, 대화형 세션, 수정 재작성 - 가 **`prompts/writing/core-rules.md`
  (한 페이지)를 제일 먼저** 읽고, 나머지 목록은 `src/workflows/writing/specFiles.ts`가 정한다. 계정 레벨
  스킬(`*-blog-writer`)은 쓰지 않는다(클라우드에서 로드되지 않고 맥과 규격이 갈라진다). 대화형으로 원고를
  쓸 때는 프로젝트 스킬 `write-manuscript`를 쓴다. 저장 직전 `enforceWritingRules`가 금지 표현을 코드로
  집행한다.
- 키워드 승인 → 자료조사 → 집필: `prompts/research/researcher.md` → `prompts/writing/core-rules.md` +
  `writer.md`가 규격이다. Claude(리드)는 직접 리서치·집필하지 않고 이 서브 스펙을 호출·조율·감독만 한다.
  헤드리스 실행(`claude -p`)도 이 스펙과 `docs/seo-guide.md`를 로드해 따른다. 산출물은 파일이다
  (`research/[키워드].md`, `drafts/[키워드].md`).
- 자료조사 검색은 하이브리드다. Node가 NAVER API로 기준 sources(감사 베이스라인)를 모으고,
  researcher 에이전트가 WebSearch/WebFetch로 빈칸을 보강한다. 둘 다 `research/*.md`와 `sources`에 남는다.
- **채널은 셋이다 - Blogspot, 네이버, 티스토리**. 운영 블로그도 이 셋뿐이다(2026-10-13 사용자
  확인): 네이버 "Whyissuenow"(엔터), 티스토리 "핫이슈 설명서"(사회 사건·사고), 블로그스팟
  "Korea Plain"(한국 사용설명서, 태그라인 "Korea, in plain English" - 2026-10-28 "The Korea Manual"에서 리브랜딩, 주소는 아직 그대로). 옛 육아 블로그("우아 아빠의 쌍둥이 키우기")는 미운영이고
  `style/parenting.md`는 보존 규격이다. (2026-10-05 개편2에서 티스토리 자동 발행 재개.
  2026-09-15에 접었던 전제가 바뀌었다 - 사용자가 PC 앞에서 운영하므로 로그인 풀림에 바로 개입할
  수 있다. 상세는 `docs/ai-handoff/TISTORY_AUTO_PUBLISH_DESIGN.md`). 카테고리→채널 배정
  (`config/channelRouting.ts`)은 없다 - **어느 채널에 올릴지는 라우팅이 아니라 사람이 버튼으로
  정한다.** 다만 2026-10 개편부터 **트랙이 버튼 구성을 정한다** - 엔터 트랙은 🟢 네이버,
  사회 트랙은 🟠 티스토리, 사용설명서 트랙은 🔵 Blogger 버튼이 뜬다(`job.metadata.track`, 없으면 엔터).
  - Blogspot(`thekoreamanual.blogspot.com` - "Korea Plain", 구 "The Korea Manual", 사용설명서 트랙): 공식 API(Blogger v3).
    GitHub Actions에서 바로 끝난다. 옛 대상 `whynowissue.blogspot.com`은 **2026-10-11 폐쇄**됐고
    2026-10 개편으로 엔터·사회 버튼에서도 빠졌다. 사용설명서 트랙(개편3, 2026-10-06)만 쓴다 - 트랙 버튼은
    `🔵 Blogger 발행`이고 대상은 `thekoreamanual.blogspot.com`(`KSCENE_BLOGGER_BLOG_ID`, **비면 발행하지 않는다** -
    `BLOGGER_BLOG_ID`로 폴백하지 않는다). 사용설명서 원고는 **한글 초고 → 한글 ✅ → 영어본(`job-translate`) →
    자동 승인 → 이미지가 포함된 영어본 → 통합 알림(발행/수정/반려)**이고(2026-10-12부터 영어본 단독 재승인 폐지, 게이트 꺼짐이면 옛 영어본 재승인 ✅ 복귀), 발행 시 이미지를 공개 Cloudflare Pages로 복사해 본문 URL을 치환한다
    (`docs/ai-handoff/RESTRUCTURE_3_KSCENE_TRACK.md`).
  - 티스토리(`wooahpapa.tistory.com` - "핫이슈 설명서", 사회 트랙): 공식 API가 없어 네이버와 같은 구조다 -
    클라우드는 `job.metadata.tistoryPublish` 큐에 요청만 남기고 **맥미니 폴러**(`tistory-poll`)가
    Playwright(TinyMCE)로 **임시저장**한다(2026-11-05부터 - 아래 `TISTORY_PUBLISH_MODE`). 로그인 풀림은
    실패가 아니라 **대기(deferred)** - 재로그인하면 자동 재개, 3일 지나면 버튼을 다시 눌러야 한다.
    첫 운영은 비공개(`TISTORY_PUBLISH_VISIBILITY`, 임시저장 모드에서는 쓰이지 않는다).
  - 네이버(`blog.naver.com/whyissuenow` - "Whyissuenow", 엔터 트랙): **공식 발행 API가 없다.** Playwright로 로그인된
    브라우저를 조작하므로 GitHub Actions에서 돌릴 수 없다 - 클라우드는 요청만 남기고
    **맥의 로컬 폴러**(`job:naver-poll`)가 집어 간다. 맥이 꺼져 있으면 켜질 때 처리된다.
    Creator Advisor가 보는 블로그(육아)와 **다른 계정**이라 세션 프로필도 분리돼 있다
    (`NAVER_PUBLISH_BLOG_ID`, `NAVER_PUBLISH_PROFILE_DIR`).
  - 같은 글을 두 채널에 올리므로 **유사문서 판정**이 위험이다. `generateNaverVariant`가 텍스트를
    다시 쓰고(이미지는 두 채널이 **같은 것**을 쓴다), 네이버 원고에서는 `참고 자료` 링크아웃을
    뺀다. 발행 간격은 코드가 강제하지 않는다 - 사용자가 그때그때 판단한다(2026-09-22 결정).
- 원고 내 이미지: writer가 남긴 `[IMAGE: 설명]` + `[IMAGE PROMPT: ...]` 마커 쌍으로 **승인 이후**
  자동 생성한다(`workflows/images/generateManuscriptImages.ts`). **코드 기본값과 운영값이 같다 -
  켜짐**(2026-10-03 정렬. 전에는 코드 false / 운영 variables `MANUSCRIPT_IMAGE_GENERATION=true`로 갈려
  맥 로컬과 클라우드가 다르게 돌았다). 끄려면 `=false`를 명시한다. OPENAI 키가 없으면 생성 단계가 실패로
  기록되고 원고는 그대로 진행된다. A/B 비교는 끝났다 - **`IMAGE_AB_COMPARE` 기본값도 운영값(false)**이다
  (2026-10-03 정렬). `IMAGE_PROVIDER=openai`. 웹 검색으로 채우는 자리는 네이버 + 구글 두 색인을 쓴다
  (구글은 공식 API가 신규 발급 차단이라 Serper 중계, `SERPER_API_KEY`). 생성 이미지는 Supabase
  Storage(`article-images`)가 원본이고 `npm run sync:images`가 맥으로 내려받는다. 옛 경로
  (`ARTICLE_IMAGE_GENERATION` + `workflows/writing/generateArticleImages.ts`, 자체 브리프 생성 후
  본문에 마크다운 삽입)는 계속 false이고 호출하지 않는다 - 지우지는 않았다.
  `IMAGE PROMPT`는 지시문이 아니라 그대로 붙여넣을 수 있는 완성된 문자열이어야 한다
  (`prompts/writing/rules/images.md` §8).
- **이미지 규격이 둘이다**(2026-10-01 분업). 집필자는 "이 자리에 무엇을 보여줄지"만 정하고, 어디서
  어떻게 구할지는 이미지 메이커가 정한다.
  - 집필자용(자리 설계): `prompts/writing/rules/images.md`
  - **실행자용(수집·선택·생성)**: `prompts/images/image-maker.md` - 수집·선택 에이전트가 프롬프트
    맨 앞에 읽는다(`images/imageMakerSpec.ts`). **구하는 방법에 관해서는 이쪽이 최신이고 이긴다.**
  - 발행 캡션은 **사진을 보고 다시 쓴 수집 캡션**을 쓰고 획득 방식 꼬리(`— 웹 검색`)를 떼어 낸다.
  - 저작권은 1순위 기준이 아니다 - **유료 스톡만 거부**한다(2026-10-01 사용자 결정).
  - 인포그래픽은 행사·정책, 그리고 법률·혐의·처벌 기준에 쓴다(`— 인포그래픽 생성`, 법률은 2026-10-02).
    **본문 표를 그대로 옮긴 이미지는 계속 금지**다(`— 표 생성`은 코드가 본문에서 지운다).
  - **이미지는 문단이 무엇에 관한 것인지만 보여주면 된다**(2026-10-02 사용자 원칙). 문단 내용을 다 담으려
    하지 않는다 - 건물 외관·일반 장면으로 빠진다. **언론사 기사 화면 캡처는 전 카테고리에서 폐지**(남발). **공인 사건은
    당사자 실사진**을 쓰고, 피해자·미성년자·일반인 피의자만 AI로 대체한다. **방송에 얼굴을 공개하고 나온
    출연자(예능·리얼리티)는 보호 대상이 아니다** - 그 회차 방송 화면(자막 포함)을 쓴다. MC·패널은 주인공이 아니다.
  - **2샷·단체샷·합성컷도 쓴다**(2026-10-02, 옛 "단독 인물 자리 단체 사진 제외·합성컷 회피" 폐지 - 영상물은
    그런 컷이 대부분이라 비우는 쪽이 손해). 관찰 중이라 스위치로 남겼다: `IMAGE_GROUP_SHOTS=false`면 옛 규칙.
- **초안 승인 단계는 없다**(2026-10-08 단계 통합, `PIPELINE-MERGE-2026-10.md`). 흐름은 **키워드 Go → 자료조사 ✍️ → write → 자동
  승인(`metadata.autoApprovedAt`) + `job-publish-prepare` 즉시 발화 → 이미지 반영 원고 → 통합 알림 한 번(발행/수정/반려)**이다.
  옛 "원고 완료 알림(Telegraph 미리보기 + ✅/✏️/🗑)"은 폐지했다(Telegraph 서비스는 호출만 뺐다). 게이트
  **`PIPELINE_SKIP_DRAFT_REVIEW`**(미설정·빈 값 = 켜짐, `false`면 옛 2단계 흐름 복귀 - 승인 없이 바꾸지 않는다. 워크플로 repo
  variable, `job-write.yml`·`job-revise.yml`). 사용설명서(kscene) 트랙은 **한글 초안 ✅는 남기고**(게이트 무관) 그 뒤 영어본 단독 재승인만 같은 게이트로 뺀다(2026-10-12): 한글 ✅ → 영어본 → 자동 승인(`autoApprovedAt`) → 이미지 포함 영어본의 통합 알림. 영어본 ✏️ 수정은 `job-translate`가 영어본만 다시 만들고 이미지는 마커 diff로 유지한다(`job-translate.yml`도 같은 게이트 변수).
  `review` 상태로 남은 옛 job은 옛 ✅/✏️/🗑으로 소진한다. 게이트·구흐름 제거는 1~2주 안정 확인 뒤 별도 커밋.
- **원고 준비**: write가 끝나면 자동 승인되어(옛 흐름에서는 텔레그램 초안 ✅ 뒤에) `prepareApprovedManuscripts()`가 작성 단계 원고
  (platform=null article)를 **그대로 최종 원고로** 삼아 `manuscripts/<날짜>/<주제>.md`에 저장하고,
  이미지를 붙이고, 이미 발행된 관련 글로 **내부 링크**를 넣은 뒤(2026-09-22 - 고아 페이지 방지. 2026-10-04부터
  DB 원고에도 저장해 버튼 발행본에 들어간다. 네이버 발행에서는 뺀다. 티스토리 발행에서는 **같은 블로그(wooahpapa.tistory.com) 링크만 남기고** blogspot·naver 등 다른 블로그 주소는 뺀다 - 2026-10-28, `filterRelatedPostsByHost`) 원고
  뷰어 페이지를 갱신한다. **배리에이션(채널별 재작성) 단계는 2026-09-30에 폐지**했다 - 채널은 아래
  버튼으로 사람이 고르므로 채널별 중복 원고가 없다. 발행 메타(검색 설명·slug·폴더 이름·태그)는 writer가
  frontmatter로 남긴다(`rules/output-format.md` §9). 트리거는 폴링이 아니라 **승인 콜백 직후 이벤트 기반**이다
  (2026-09-14, `docs/ai-handoff/CLOUD_MIGRATION.md` Phase 4) - GitHub Actions
  (`job-publish-prepare.yml`)가 실행한다.
- **발행은 사람이 버튼으로 한다**(2026-09-19 결정, 2026-09-22 네이버 추가, 2026-10-05 트랙별 구성).
  원고 준비 완료 알림의 버튼은 공통 `📄 원고 페이지 열기` / `🖼 이미지 수정` /
  `⬇️ 맥으로 내려받기`에 **트랙별 발행 버튼**이 붙는다 - 엔터는 `🟢 네이버 발행`,
  사회는 `🟠 티스토리 발행`(🔵 블로그 발행은 2026-10 개편으로 두 트랙에서 제외). 자동 승인된 원고(엔터·사회)에는 마지막 줄에
  **`✏️ 수정 요청` / `🗑 반려`**가 붙는다(통합 알림이 단일 승인 지점이다). 키보드 구성은 `buildReadyKeyboard` 한 곳이다 -
  Cloudflare 릴레이가 버튼을 누르는 순간 키보드를 "⏳ 처리 중…" 하나로 덮어쓰므로 러너가 처리 뒤 이 함수로 되살린다.
  **이미지까지 반영된 최종 원고를 뷰어에서 눈으로 본 뒤**
  누르는 것이고, 사람이 곧 품질 게이트다. 누르지 않은 원고는 올라가지 않는다.
  - **진입점은 둘이다 - 텔레그램 버튼과 사회 뷰어의 발행 버튼**(2026-11-05 사용자 요청으로 뷰어 버튼 복원.
    2026-10-07에 "텔레그램 하나"로 뺐던 것인데, 그때 서버 쪽 `/api/publish-request`(`publishApi.ts`·
    `publish-request.yml`·`jobs/publishRequestCli.ts`)를 남겨 둬서 뷰어만 되살렸다). **같은 큐**(`tistoryPublishQueue`)라
    둘 다 눌러도 한 번만 올라간다. 요청이 접수되면 그 자리에서 텔레그램 확인 메시지가 가고, 결과는 폴러가 따로 알린다.
    - 버튼은 **사회 페이지에만** 들어간다. 엔터·사용설명서 페이지에는 markup·스크립트·리스너가 **아예 없다**
      (`PUBLISH_BAR_SCRIPT`·`PUBLISH_SCRIPT`·`PUBLISH_WIRE_SCRIPT`를 `track === "social"`일 때만 끼운다).
      코드가 들어 있지 않은 것이 "그 트랙에는 진입점이 없다"는 사실을 가장 분명히 한다 - `testManuscriptTrackPages`가 단정한다.
    - **툴바 밖 자기 줄에, 다른 버튼보다 크고 다른 색**이다(`.publish-bar`/`.btn-publish`, 고정 초록 17px).
      되돌릴 수 없는 동작이라 복사·수정 버튼 사이에 같은 모양으로 섞이면 잘못 눌린다. 색을 트랙 강조색(`--pen`)에
      매지 않은 이유는 트랙마다 달라지면 "그 버튼"으로 기억되지 않기 때문이다.
    - **저장 안 된 수정이 있으면 눌리지 않는다**(저장 요청이 날아가는 중에도). 발행은 DB 원고를 읽으므로
      뷰어에서 고치고 바로 누르면 옛 글이 올라간다.
  - **뷰어에서 고친 본문·캡션·제목은 `💾 수정본 저장`을 눌러야 발행 원고(DB)에 들어간다**(2026-10-03, 버튼 이름은
    2026-10-07에 "반영"→"저장"). 누르기 전에는 복사에만 쓰인다. **저장은 저장일 뿐 발행하지 않는다.** 경로: Pages
    Function → `manuscript-edit.yml` → `applyViewerEditRequest.ts`. 편집 키는 본문 블록 번호·`N:h`/`N:b`·`cap:N`·
    **`title`**(제목, 2026-10-07 - `articles.title`의 final article 행 + manifest 제목. slug·검색설명·폴더명은 안 바뀌고
    이미 발행된 글에 소급되지 않는다).
  - **수정-발행 경합 가드**(2026-10-07, `viewerEditGuard.ts`): 반영 요청이 접수되면 `job.metadata.viewerEditPendingAt`,
    이미지 교체는 `imagePickPendingAt`을 남기고 완료 기록(`viewerEdit.appliedAt` / `imagePick.at`)이 그 뒤 시각이 될
    때까지 네이버·티스토리 폴러(`listPending*Requests`)와 텔레그램 발행 콜백(naver/tistory/blogspot)이 그 원고를 집지
    않는다(콜백은 "수정 반영 진행 중 - 잠시 후 다시 누르세요"). 10분 넘으면 stale로 보고 막지 않고 경고 알림 후 진행한다.
  - **후보 이미지 클릭 교체**(2026-10-07): 뷰어 후보 썸네일을 누르면 그 자리(슬롯)만 바뀐다. 경로: Pages Function
    `/api/image-pick` → `image-pick.yml`(repository_dispatch `image_pick`) → `applyImagePickCli.ts`/`applyImagePick.ts`.
    **후보 URL은 DB `imageCandidates`에서 번호로 찾고 클라이언트 URL은 신뢰하지 않으며**, 뷰어가 본 채택본(`fromUrl`)이
    지금과 다르면 중단한다. 내려받기(`defaultFetchImage`, referer=출처) → 크기·형식 검사 → 긴 세로 자르기 → Storage 같은
    경로 upsert → `metadata.images[슬롯]`·`imageCandidates.picked`·manifest → 페이지 재배포. 캡션은 그대로(뷰어에서 수정).
    **원고 준비는 다시 돌리지 않고 준비 완료 알림도 다시 보내지 않는다.** 다만 **교체가 끝나면 그 트랙 봇으로 한 통
    알린다**(2026-11-05, `imagePickDoneMessage` - 전에는 실패와 「이미 발행된 글」만 알렸다): 교체가 1~2분 걸리는데
    성공이 조용해서 끝났는지 보려고 뷰어를 계속 새로고침해야 했고, 뷰어의 「⏳ 교체 중」 표식은 localStorage라
    **다른 기기에서는 보이지 않는다**. 알림은 **배포까지 끝난 뒤** 보내고 `📄 원고 페이지 열기` 버튼이 붙는다
    (주소 규칙은 `buildReadyKeyboard`와 같다). **교체 1건 = 알림 1통**이다(run이 건마다 따로 돌아 묶을 수 없다 -
    한 글에서 3장을 바꾸면 3통). 실패(403·소멸·너무 작음)는 manifest(`imagePick`)와 텔레그램에 남는다.
    이미 발행된 글에는 반영되지 않는다(알림에 그 한 줄이 붙는다). 텔레그램 `🖼 이미지 수정`(`N번 후보M` 등 **답장형 재수집 → 원고 준비 재실행**)은
    후보가 다 마음에 안 들 때의 대체 수단으로 그대로 있다.
  - **✏️ 수정 요청**(2026-10-08): 누르면 "이 메시지에 답장" 안내가 오고 답장하면 `job-revise`가 돈다. 이미지가 이미 붙은 원고라
    **마커 diff**로 이미지를 다룬다(`reconcileReviseImages.ts`) - `[IMAGE: …]` 마커가 그대로면 이미지를 유지한 채 뷰어만 재배포,
    같은 개수에서 설명이 바뀐 자리만 재수집, 개수가 바뀌면 처음 달라진 자리부터 뒤쪽만 재수집(전체 재실행 없음). 끝나면 통합 알림이
    버튼 동일하게 다시 온다. revise 프롬프트에 "마커 위치·개수·내용 유지" 지시가 있다.
  - **🗑 반려**(2026-10-08): `rejected` + `rejectedAt` 기록 + 뷰어 manifest 행 삭제 + 페이지 재배포. **이미 발행됐거나 발행 중이면
    거부**한다. 이미지는 `storage-cleanup`이 **반려 7일 뒤**(발행 이력 없음 확인, dry-run 기본) 지운다.
  - **티스토리는 임시저장까지만 한다**(2026-11-05 사용자 지시, `TISTORY_PUBLISH_MODE=draft`가 코드·운영
    기본값). 버튼 문구도 `🟠 티스토리 임시저장`이고, 맥미니가 임시저장한 뒤 **글 관리 링크를 텔레그램으로
    보내면 사람이 직접 발행한다**(`draftSavedMessage`). 발행 레이어를 **열지 않는다** - 캡차가 거기서 뜬다.
    `publications`에는 **아무 행도 남기지 않는다**(사람이 발행하면 그때 기록된다) - 그래서 **일일 1건 상한과
    최소 발행 간격은 임시저장에 적용되지 않는다**(둘 다 publications를 센다). 발행 속도는 이제 사람이 정한다.
    - 왜: 카카오 캡차가 매번 자동 발행을 막았고(10/31·11/01·11/02), 막힐 때마다 임시저장으로 떨어지는
      상태를 그대로 두면 **네이버가 자동 발행으로 저품질을 받았던 전례**처럼 블로그 품질에 영향이 갈 수
      있다는 사용자 판단이다. 캡차를 피해 임시저장을 **정상 경로**로 삼았다.
    - 되돌리기: `TISTORY_PUBLISH_MODE=publish`(발행 게이트 - 승인 없이 바꾸지 않는다). 그러면 버튼 문구·
      안내·흐름이 옛 자동 발행으로 돌아간다.
    - **한 번 누르면 임시저장 1건**이다. 버튼은 되살아나므로 다시 누르면 **임시저장이 하나 더 생긴다** -
      글 관리에서 중복을 지워야 한다.
  - 네이버·Blogspot은 임시저장을 쓰지 않는다. 네이버 임시저장 글은 다시 열 때 레이어 팝업이 떠 흐름을
    꼬았고, Blogspot 초안은 발행 버튼이 "이미 올라가 있음"에 막혀 매번 수동 공개가 필요했다.
    **티스토리 캡차 대응**(2026-11-02 사용자 승인, 임시저장 모드에서는 거의 닿지 않는 경로). 카카오 캡차가 뜨면 발행이 막히는데 캡차는
    사람만 풀 수 있고 맥미니 앞에는 사람이 없다(헤드리스를 꺼도 창을 볼 사람이 없고 30초 안에
    풀 수도 없다 - 10/31·11/01 실측). 그래서 **캡차를 감지하면 실패로 끝내지 않고 임시저장해
    원고를 남기고**, 알림이 글 관리 링크와 함께 "캡차만 풀면 됩니다"로 안내한다
    (`TistoryPublisher` stage `captcha` → `publishJobToTistory` reason `captcha` → 폴러
    `captchaMessage`). `publications`에 failed를 남기지 않는다(로그인 대기와 같은 취급).
    자동 재시도는 없다 - 또 막힌다. 버튼은 되살아나므로 캡차가 가라앉은 뒤 다시 누르면 된다.
  - **자동 재시도는 없다.** 실패하면 버튼이 `(재시도)`로 되살아난다 - 눌러야 다시 돈다.
  - 하루 발행 상한은 **20건**(`BLOGGER_DAILY_LIMIT`, 2026-09-22에 5에서 상향). "오늘"은
    **한국시간 자정** 기준이다(전에는 서버 UTC 자정이라 오전 9시에 초기화됐다).
- **공개 범위**: Blogspot은 버튼 경로에서 `asDraft: false`로 **공개 발행**한다
  (`BLOGGER_PUBLISH_AS_DRAFT=true`는 이 경로를 막지 못한다 - 호출 인자가 우선한다).
  네이버는 **기본이 비공개**이고 `NAVER_PUBLISH_VISIBILITY=public`으로만 공개된다
  (2026-09-22 사용자 결정 - 첫 운영은 비공개로 확인한 뒤 올린다).
- **자동 발행(사람 없이 나가는 경로)은 여전히 없다.** `publishApprovedArticles.ts`(폴링 fan-out)는
  2026-09-05부터 호출되지 않는다 - 코드와 테스트만 남아 있다. 되살리는 기준은 "원고·이미지 품질이
  보장됐다"는 **사용자 판단**이다.
- 발행 게이트 환경변수(승인 없이 건드리지 않는다):
  - `BLOGGER_ENABLED` - 마스터 게이트. false면 버튼도 `disabled`로 실패한다(기본 false).
  - `TISTORY_PUBLISH_MODE` - `draft`(기본, 임시저장까지만) / `publish`(옛 자동 발행). 2026-11-05 신설.
  - `BLOGGER_AUTO_PUBLISH`는 **존재하지 않는다** - 예전 이 문서에 적혀 있었으나 코드·워크플로우·
    `.env.example` 어디에도 없는 이름이다. 찾지 말 것.

## 키워드 수집·알림 스케줄 (2026-10-11 개편)

Worker cron 하나(`0 9,10,11,12 * * *`)가 발화 UTC 시로 워크플로를 고른다
(`cloudflare/telegram-relay/src/schedule.ts` + `wrangler.toml` - **둘을 항상 같이 바꾼다.** 한쪽만
바꾸면 발화가 조용히 죽는다). cron 슬롯은 4/5, 마지막 1칸은 예약이다.

- **dispatch는 흔들리면 다시 던져본다**(2026-11-04): 네트워크 오류·5xx·429·408이면 2·6·12초 뒤까지 최대
  4회(`dispatchWorkflow`). 4xx는 토큰·권한·입력 문제라 재시도하지 않고 바로 오류로 남긴다. 계기는
  2026-11-04 GitHub 장애(09:49~11:30 UTC, impact major) - 10·11 UTC 회차(핫이슈 스타·사회)가 통째로
  사라졌다(POST 한 번 실패 = 그날 수집 전부, 다음 기회는 24시간 뒤). **이 창(약 20초)으로 몇 시간짜리
  장애는 못 넘는다** - 그건 아래 따라잡기가 맡는다.
- **앞 시각이 빠지면 다음 발화가 따라잡는다**(catch-up, 2026-11-04): 키워드 cron이 깨어날 때마다 **앞
  시각**의 수집에 그날 run이 있는지 GitHub에 묻고, **아예 없는 것만** 다시 깨운다(`catchUpTargets` +
  `catchUpMissed`). 10 UTC가 빠지면 11 UTC가, 11 UTC가 빠지면 12 UTC가 메우므로 몇 시간짜리 장애도
  그날 안에 복구된다 - 수집일 경계가 KST 05:00이라 **그날 분으로 집계**된다. 새 cron 슬롯도 새 토큰도
  쓰지 않는다(마지막 1칸은 계속 예약).
  - **실패한 run도 "돌았다"로 센다** - 메우려는 구멍은 "아예 안 돈 것"이고, 실패는 사람이 로그를 볼 일이다.
  - **watchdog은 따라잡기 대상이 아니다**(`catchUp: false`) - 수집 산출물이 없고 자기 시각이 아닌 때 돌면
    판정이 엉킨다. 새 워크플로를 슬롯에 넣을 때 이 플래그를 함께 판단한다.
  - **마지막 시각(12 UTC)이 빠지면 못 따라잡는다** - 뒤에 깨어날 발화가 없다. 그건 watchdog 알림을 보고
    사람이 `gh workflow run <파일>`로 돌린다.
  - 따라잡기가 실패해도(토큰에 run 읽기 권한이 없으면) **그 시각의 본 수집은 건드리지 않는다** - 던지지
    않고 `[catch-up]` 오류 로그만 남긴다. 그 경우 동작은 고치기 전과 같아진다(watchdog 알림만 나간다).

| KST | UTC | 워크플로 | 알림 |
|---|---|---|---|
| 18:00 | 09 | `entertainment-keyword.yml` (round=evening) | 엔터 메인봇 · Go/Pass |
| 19:00 | 10 | `entertainment-hot-star.yml` | 엔터 메인봇 · 인물별 **`✍️ 인물글` 버튼**(`pgo:`, 인물 백과 트랙) |
| 20:00 | 11 | `social-issue-keyword.yml` | 사회 봇 · Go/Pass |
| 21:00 | 12 | `kscene-topic.yml` + `watchdog.yml` | 사용설명서 봇 · Go/Pass |

- **엔터는 하루 1회(18시)다**(2026-10-11, `KEYWORD-REFRESH-2026-10.md` §A). 09·13시 회차는 알림 중복이
  많아 폐지했다 - Worker에서 0·4 UTC를 빼고 **watchdog 기대 목록(`WATCHED_JOBS`)에서도 뺐다**(안 빼면
  매일 거짓 경보). 회차 체계(`config/keywordRound.ts`)는 **코드로는 유지**한다(수동 `workflow_dispatch`의
  `round` 입력 + 시각 추정 안전망). 운영 회차에서는 알림 제목의 회차 표기를 생략한다(`OPERATING_ROUND`).
  엔터 수집이 1/3로 줄어 Serper·NAVER 호출도 그만큼 줄었다.
- **19시 핫이슈 스타 Top 5**는 그날 가장 이슈가 된 인물 5명 + 화제 배경을 보낸다. **인물별 `✍️ 인물글`
  버튼**이 붙고(2026-10-13 인물 백과 트랙 - 2026-10-11의 "읽기용·버튼 없음"을 대체), 누르면
  `category=person` job이 만들어져 기존 엔터 트랙 흐름(자료조사 → write 자동 → 통합 알림 → 뷰어 반영까지; 네이버 업로드는 뷰어에서 복사해 수동 복붙, 발행 버튼·자동 발행 없음 - 2026-10-14 사용자 결정)을 탄다.
  버튼은 `discovery_runs.metadata.people[]`를 근거로 하며 `keyword_rankings`는 만들지 않는다. 재료는 그날 이미 쌓인 데이터뿐(18시 run의 `keyword_rankings` + 당일 `trend_candidates`)이고
  보조 수집(NAVER·Serper) 호출이 0건이며, 인물 추출만 `claude -p` 1콜을 쓴다. 18시 알림과 인물이 겹치면
  **중복 제거 없이** "18시 알림에도 선정" 한 줄을 붙인다. 5명을 못 채우면 채운 만큼 보내고 "오늘은 N명"
  이라고 적는다. run은 `discovery_runs`에 `kind=entertainment-hot-star`로 남고 `keyword_rankings`는
  만들지 않는다(Go 버튼이 가리킬 행이 없어야 한다 - `config/discoveryRunKinds.ts`).
- **사회 트랙(티스토리)은 4060 남성이 독자이고 정치를 받는다**(2026-11-01 개편, `TISTORY-DIRECTION-2026-11.md`).
  정체성은 "핫이슈 설명서 - 힘 가진 쪽이 무엇을 어떻게 잘못했는지 설명하는 블로그"다. 근거는 발행본
  103건(게시 7일 경과) 실측 - `정치와 국정` 1.46배·`사건·사고와 재판` 1.46배가 최상위이고
  `인물과 스타 이슈` 0.26배가 최하위였다. **경제(0.80배)는 근거가 없어 메인으로 올리지 않았다.**
  - **정치 배제는 트랙별로 갈린다**: 사회는 `allowPolitics: true`로 받고 엔터(네이버)는 그대로 배제한다.
    `trend_candidates` 저장소는 정치를 품고(`excludeCandidateInserts`), 트랙 판정은 읽는 쪽
    (`dailyKeywordWorkflow`)에서 한다. 집필 균형 조건은 `style/incident.md` 「정치·국정 사안」이다 -
    **양측 근거를 같은 무게로 쓰고 누가 옳은지 판정하지 않는다.**
  - **엔터 누수는 어휘가 아니라 출처로 막는다**(`entertainmentPicksOfDay.ts`). 강유미·김용건·이찬혁처럼
    **사람 이름뿐인 키워드**는 어휘 목록으로 못 잡는다 - 그날 엔터 run(18시 키워드 + 19시 핫이슈 스타
    `metadata.people[]`)이 이미 집은 것과 대조한다. `isEntertainmentLeak` 어휘 판정은 그대로 두고 더한다.
  - 섹션은 `🚨 사건·사고 / 🏛 정치·국정 / 📋 정책·제도 / 💰 경제·부동산 / 📡 화제·발견`이다(옛 `생활·기타`는 접었다).
  - **공분 신호 🔥**: 힘 가진 쪽의 부조리를 짚는 키워드에 알림 뱃지를 붙인다. 실측 **평균 3.91배·중앙값 3.0배**로
    카테고리(최대 1.46배)보다 강한 신호다. **점수에는 넣지 않는다**(6-factor 변경은 승인 항목) - 표시만 한다.
  - **티스토리 하루 1건 상한은 폐지했다**(2026-11-05 사용자 지시). 2026-11-01에 애드센스 반려("가치가
    별로 없는 콘텐츠")를 받고 넣었지만, 발행이 임시저장 + 사람이 직접 발행으로 바뀌면서 코드가 셀 수
    없는 규칙이 됐다(임시저장은 publications 행을 남기지 않는다) - 지켜지지도 않으면서 자동 경로만 막는다.
    장치는 남아 있다: `TISTORY_PUBLISH_DAILY_LIMIT=1`이면 되살아난다(KST 자정 기준, 기본값 0=상한 없음).
    대신 **하루 1회 발행본을 읽어 DB에 적립한다**(`npm run tistory:inventory`, analytics-search.yml 동승) -
    무엇이 언제 올라갔는지는 거기서 본다. **최소 발행 간격 5분 가드는 그대로다**(캡차·저품질 패턴 방어).
- **사용설명서(kscene) 주제 선정은 체류 실용 정보를 문화 소개와 동등하게 우선한다**(§C). 시드는 117개
  (기획⑤ 확정본 100 + 실용 17, Living in Korea 32 / Travel & Transit 25 / 나머지 20)이고, 선정에
  라벨 상한과 짝이 되는 **실용 하한**(`practicalFloor`, topN=8이면 3건)이 있다. 실용 후보가 적은 날은
  있는 만큼만 뽑는다. 이 트랙의 주제 선정에는 LLM 프롬프트가 없다 - 기준은 `ksceneTopics.ts`의 규칙이다.

## 측정·분석 운영 규칙 (2026-10-08)

- **GSC는 속성 목록을 돈다**: repo variable `GSC_SITE_URLS`(콤마 구분, 순서대로: thekoreamanual → 티스토리. whynowissue.blogspot.com은 폐쇄돼 2026-10-11에 제외했다).
  비면 `GSC_SITE_URL` 단일 폴백. 속성 = `page_url` 호스트라 `search_performance_daily` 구조는 그대로다(migration 없음).
  새 속성 추가는 변수에 한 항목 덧붙이고 `analytics:search -- --site=<속성> --days=N --apply`로 백필.
- **주간 리포트**(`analytics:weekly-report`)는 새 Worker cron을 쓰지 않는다 - 주간 `analytics-index-health.yml`에 동승한다.
  주간 슬롯(`0 1 * * 1`)은 표현식이 월요일인데 **실제 발화는 일요일 10:00 KST다**(2026-11-02 실측 - 10/18·10/25·11/01
  세 주 연속). run을 찾을 때 월요일 자리를 보면 없다. 점검이 15분 타임아웃에 걸려 주간 리포트까지 건너뛰어진 적이
  있어(11/01) 색인 점검은 호출 6개 병렬 + 타임아웃 30분이다(2026-11-02).
  Worker cron은 4/5 사용, 마지막 1슬롯은 예약이다. 14일 미만 데이터 속성은 "축적 중"만 표기한다.
- **발행 이미지 생존 점검**(`images:health`, 2026-11-03): 사용설명서 발행본의 Pages 이미지를 하루 1회 HEAD로 찍어
  사라진 게 있으면 사용설명서 봇으로 알린다(조용한 날은 보내지 않는다). 새 cron 슬롯 없이 일일 `analytics-search`
  슬롯(`30 0 * * *`, 09:30 KST)에 동승한다 - `kscene-image-health.yml`. **블로그 글을 긁지 않는다**: 발행 HTML이
  가리키는 Pages URL은 `job.metadata.rehostedBySource`에 있으므로 DB에서 읽는다(사이트맵 크롤은 구글이 50여 편에서
  429로 끊는다 - 2026-11-03 실측). 404·410만 고장으로 보고 타임아웃·5xx는 「확인 실패」로 따로 센다. 깨진 글의
  Supabase 원본까지 찍어 **복구 가능 여부**를 같이 알린다 - 복구는 `npm run images:repair-pages -- <jobId...> --apply`이고
  원본이 지워지기 전에만 된다(`storage-cleanup`이 발행 14일 뒤 지운다). 상세는 `images/classifyPagesImageHealth.ts`.
- GA4 수집은 서비스 계정(기존 `GSC_SERVICE_ACCOUNT_JSON` 재사용)으로 `analytics:ga4`가 `ga4_performance_daily`에 upsert한다
  (repo variable `GA4_PROPERTY_IDS`=`라벨:숫자속성ID` 콤마 목록, 일일 `analytics-search.yml`에 동승) - `docs/ai-handoff/ANALYTICS_OPS.md` §2. 네이버 조회수는 GSC·GA4 밖이고 맥미니 수집 세션 소유다.

## 승인 없이는 금지

- Supabase migration 적용 또는 migration history 변경
- 원격/운영 DB insert, update, delete, backfill, cleanup
- Telegram/Kakao 등 외부 메시지 발송 또는 설정 변경
- production 배포, 유료 결제·업그레이드
- 파괴적 Git 작업, 원격 push, merge
- final 6-factor scoring, relevance, clustering 로직 변경

승인이 필요한 작업은 정확한 대상, 영향, 되돌리기 방법, 검증 절차를 먼저 제시한다.

## 현재 핵심 문서

- 발행 채널 설계: `docs/ai-handoff/BLOGSPOT_ONLY_DESIGN.md` (제목은 "단독"이지만 2026-09-22에
  네이버가 다시 들어왔다 - 채널 수는 위 운영 규칙이 최신이다)
- 진척 원장(데일리 데스크 대시보드가 읽는다): `docs/ai-handoff/PROGRESS.md`
- 상태와 다음 단계: `docs/ai-handoff/CURRENT_STATE.md`
- 인스타 포스팅 변환기(별도 워크트리, 미병합): `docs/ai-handoff/INSTAGRAM_POSTING_CONVERTER.md`
- 폴더·브랜치·배포 흐름: `docs/ai-handoff/WORKFLOW.md`
- 자료조사 규격: `prompts/research/researcher.md`
- 집필 규격(라우팅·입력계약·체크리스트): `prompts/writing/writer.md`
  - **한 페이지 핵심 규칙(가장 먼저, 충돌 시 최우선)**: `prompts/writing/core-rules.md`
  - 사실·헤지 상세 사례: `prompts/writing/rules/facts-and-hedging.md`
  - 출력 형식 계약(코드와 직결, 구 writer.md §6~7·9~10): `prompts/writing/rules/output-format.md`
  - 이미지 규칙(마커·획득 방식·프롬프트, 구 output-format §8, 2026-09-30 분리): `prompts/writing/rules/images.md`
  - 카테고리별 문체: `prompts/writing/style/{parenting,entertainment,trend,incident}.md`
- 이미지 메이커 규격(수집·선택·생성 실행자, 2026-10-01 신설): `prompts/images/image-maker.md`
- SEO/AEO/GEO 규칙집: `docs/seo-guide.md` (2026-09-22에 근거 없는 규칙 7가지를 걷어냈다 -
  취소선 항목은 "이미 확인해서 뺀 통설"이니 다시 가져오지 않는다. 문서 제목은 네이버 기준이지만
  구글 기준이 먼저다)
- Codex 위임 양식: `docs/ai-handoff/CODEX_TASK_TEMPLATE.md`
- Codex 위임 스킬: `.claude/skills/delegate-codex/SKILL.md`

문서와 실제 코드가 다르면 실제 저장소 상태를 우선하고 `CURRENT_STATE.md`를 갱신한다. 비밀값이 있는
`.env` 및 세션 프로필은 명시적 필요와 사용자 승인 없이 열거나 출력하지 않는다.
