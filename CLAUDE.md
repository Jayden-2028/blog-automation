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

결과 보고, 설명, 승인 요청은 **최대한 쉽고 간결하게** 한다. 핵심 결론을 먼저 말하고, 세부는
필요할 때만 덧붙인다. 승인 요청은 "무엇을·왜·되돌리는 법"만 짧게 제시한다. 긴 표와 장황한
배경 설명은 사용자가 요청할 때만 편다.

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

- **규격 모드가 둘이다**(2026-09-23 검증, `src/config/writingMode.ts`). 기본은 `spec`(아래 규격
  그대로). `WRITING_MODE=auto` 또는 `job.metadata.writingMode="auto"`면 자율 모드로 돌아
  `researcher-auto.md` / `writer-auto.md` **하나씩만** 읽고, 기획 브리프·수집 카테고리·소제목
  뼈대·분량·이미지 개수를 **AI가 정한다**. 규격 2,549줄/체크박스 115개가 주제별 핵심을 덮는지
  보려는 것이다(실측: 고윤정 티저는 영상을 안 열어봤고, 영등포 박람회는 못 찾은 것이 주제가 됐다).
  metadata가 환경변수를 이긴다 - 한 런에서 키워드별로 갈라야 A/B가 된다. A/B용 job 복제는
  `npx tsx scripts/cloneJobForWritingModeAB.ts <jobId> --confirm`. 검증이 끝나면 한쪽을 지운다.
- 키워드 승인 → 자료조사 → 집필: `prompts/research/researcher.md` → `prompts/writing/writer.md`가
  규격이다. Claude(리드)는 직접 리서치·집필하지 않고 이 서브 스펙을 호출·조율·감독만 한다.
  헤드리스 실행(`claude -p`)도 이 스펙과 `docs/seo-guide.md`를 로드해 따른다. 산출물은 파일이다
  (`research/[키워드].md`, `drafts/[키워드].md`).
- 자료조사 검색은 하이브리드다. Node가 NAVER API로 기준 sources(감사 베이스라인)를 모으고,
  researcher 에이전트가 WebSearch/WebFetch로 빈칸을 보강한다. 둘 다 `research/*.md`와 `sources`에 남는다.
- **채널은 둘이다 - Blogspot과 네이버**(2026-09-22 사용자 결정으로 네이버 재개).
  티스토리는 로그인이 자주 풀리고 공식 API가 없어 운영을 접었고 코드도 전부 삭제했다
  (복구는 git revert). 카테고리→채널 배정(`config/channelRouting.ts`)은 없다 - **어느 채널에
  올릴지는 라우팅이 아니라 사람이 버튼으로 정한다.** 둘 다 눌러도 되고 한쪽만 눌러도 된다.
  - Blogspot(`whynowissue.blogspot.com`): 공식 API(Blogger v3). GitHub Actions에서 바로 끝난다.
  - 네이버(`blog.naver.com/whyissuenow`): **공식 발행 API가 없다.** Playwright로 로그인된
    브라우저를 조작하므로 GitHub Actions에서 돌릴 수 없다 - 클라우드는 요청만 남기고
    **맥의 로컬 폴러**(`job:naver-poll`)가 집어 간다. 맥이 꺼져 있으면 켜질 때 처리된다.
    Creator Advisor가 보는 블로그(육아)와 **다른 계정**이라 세션 프로필도 분리돼 있다
    (`NAVER_PUBLISH_BLOG_ID`, `NAVER_PUBLISH_PROFILE_DIR`).
  - 같은 글을 두 채널에 올리므로 **유사문서 판정**이 위험이다. `generateNaverVariant`가 텍스트를
    다시 쓰고(이미지는 두 채널이 **같은 것**을 쓴다), 네이버 원고에서는 `참고 자료` 링크아웃을
    뺀다. 발행 간격은 코드가 강제하지 않는다 - 사용자가 그때그때 판단한다(2026-09-22 결정).
- 원고 내 이미지: writer가 남긴 `[IMAGE: 설명]` + `[IMAGE PROMPT: ...]` 마커 쌍으로 **승인 이후**
  자동 생성한다(`workflows/images/generateManuscriptImages.ts`). 기본은 꺼져 있다 -
  `MANUSCRIPT_IMAGE_GENERATION=true` + `OPENAI_API_KEY`/`GEMINI_API_KEY`가 있어야 실제로 호출한다
  (유료 API라 켜는 것은 사용자 결정). A/B 비교는 끝났다 - `IMAGE_AB_COMPARE=false`,
  `IMAGE_PROVIDER=openai`로 고정됐다. 웹 검색으로 채우는 자리는 네이버 + 구글 두 색인을 쓴다
  (구글은 공식 API가 신규 발급 차단이라 Serper 중계, `SERPER_API_KEY`). 생성 이미지는 Supabase
  Storage(`article-images`)가 원본이고 `npm run sync:images`가 맥으로 내려받는다. 옛 경로
  (`ARTICLE_IMAGE_GENERATION` + `workflows/writing/generateArticleImages.ts`, 자체 브리프 생성 후
  본문에 마크다운 삽입)는 계속 false이고 호출하지 않는다 - 지우지는 않았다.
  `IMAGE PROMPT`는 지시문이 아니라 그대로 붙여넣을 수 있는 완성된 문자열이어야 한다
  (`prompts/writing/writer.md` §8).
- **원고 준비**: 텔레그램에서 초안을 승인(✅)하면 `prepareApprovedManuscripts()`가 Blogspot
  배리에이션 1건을 만들어 `manuscripts/<날짜>/<주제>.md`에 저장하고, 이미지를 붙이고,
  이미 발행된 관련 글로 **내부 링크**를 넣은 뒤(2026-09-22 - 고아 페이지 방지) 원고 뷰어
  페이지를 갱신한다. 작성 단계 산출물(platform=null article)은 그 자체로 발행되지 않고
  배리에이션의 재료로만 쓰인다. 트리거는 폴링이 아니라 **승인 콜백 직후 이벤트 기반**이다
  (2026-09-14, `docs/ai-handoff/CLOUD_MIGRATION.md` Phase 4) - GitHub Actions
  (`job-publish-prepare.yml`)가 실행한다.
- **발행은 사람이 버튼으로 한다**(2026-09-19 결정, 2026-09-22 네이버 추가). 원고 준비 완료
  알림에 버튼 4개가 붙는다 - `📄 원고 페이지 열기` / `🖼 이미지 수정`(아직 미연결) /
  `🔵 블로그 발행` / `🟢 네이버 발행`. **이미지까지 반영된 최종 원고를 뷰어에서 눈으로 본 뒤**
  누르는 것이고, 사람이 곧 품질 게이트다. 누르지 않은 원고는 올라가지 않는다.
  - 임시저장은 쓰지 않는다. 네이버 임시저장 글은 다시 열 때 레이어 팝업이 떠 흐름을 꼬았고,
    Blogspot 초안은 발행 버튼이 "이미 올라가 있음"에 막혀 매번 수동 공개가 필요했다.
  - **자동 재시도는 없다.** 실패하면 버튼이 `(재시도)`로 되살아난다 - 눌러야 다시 돈다.
  - 하루 발행 상한은 **20건**(`BLOGGER_DAILY_LIMIT`, 2026-09-22에 5에서 상향). "오늘"은
    **한국시간 자정** 기준이다(전에는 서버 UTC 자정이라 오전 9시에 초기화됐다).
- **공개 범위**: Blogspot은 버튼 경로에서 `asDraft: false`로 **공개 발행**한다
  (`BLOGGER_PUBLISH_AS_DRAFT=true`는 이 경로를 막지 못한다 - 호출 인자가 우선한다).
  네이버는 **기본이 비공개**이고 `NAVER_PUBLISH_VISIBILITY=public`으로만 공개된다
  (2026-09-22 사용자 결정 - 첫 운영은 비공개로 확인한 뒤 올린다).

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
- 폴더·브랜치·배포 흐름: `docs/ai-handoff/WORKFLOW.md`
- 자료조사 규격: `prompts/research/researcher.md`
- 집필 규격(라우팅·입력계약·체크리스트): `prompts/writing/writer.md`
  - 사실·헤지 규칙(항상 최우선, 구 writer.md §4): `prompts/writing/rules/facts-and-hedging.md`
  - 출력 형식 계약(코드와 직결, 구 writer.md §6~10): `prompts/writing/rules/output-format.md`
  - 카테고리별 문체: `prompts/writing/style/{parenting,entertainment,trend,incident}.md`
- SEO/AEO/GEO 규칙집: `docs/seo-guide.md` (2026-09-22에 근거 없는 규칙 7가지를 걷어냈다 -
  취소선 항목은 "이미 확인해서 뺀 통설"이니 다시 가져오지 않는다. 문서 제목은 네이버 기준이지만
  구글 기준이 먼저다)
- Codex 위임 양식: `docs/ai-handoff/CODEX_TASK_TEMPLATE.md`
- Codex 위임 스킬: `.claude/skills/delegate-codex/SKILL.md`

문서와 실제 코드가 다르면 실제 저장소 상태를 우선하고 `CURRENT_STATE.md`를 갱신한다. 비밀값이 있는
`.env` 및 세션 프로필은 명시적 필요와 사용자 승인 없이 열거나 출력하지 않는다.
