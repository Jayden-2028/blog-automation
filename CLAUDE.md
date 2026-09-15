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

- 키워드 승인 → 자료조사 → 집필: `prompts/research/researcher.md` → `prompts/writing/writer.md`가
  규격이다. Claude(리드)는 직접 리서치·집필하지 않고 이 서브 스펙을 호출·조율·감독만 한다.
  헤드리스 실행(`claude -p`)도 이 스펙과 `docs/seo-guide.md`를 로드해 따른다. 산출물은 파일이다
  (`research/[키워드].md`, `drafts/[키워드].md`).
- 자료조사 검색은 하이브리드다. Node가 NAVER API로 기준 sources(감사 베이스라인)를 모으고,
  researcher 에이전트가 WebSearch/WebFetch로 빈칸을 보강한다. 둘 다 `research/*.md`와 `sources`에 남는다.
- **채널은 Blogspot 하나다**(2026-09-15 사용자 결정, `docs/ai-handoff/BLOGSPOT_ONLY_DESIGN.md`).
  티스토리는 로그인이 자주 풀리고 공식 API가 없어 풀 자동화가 불가능해 운영을 접었고, 관련 코드는
  전부 삭제했다(복구는 git revert). 카테고리→채널 배정(`config/channelRouting.ts`)도 함께 사라졌다 -
  이제 모든 카테고리가 Blogspot으로 간다. 네이버 관련 dormant 코드는 사용자가 별도 프로세스로
  재설계 예정이라 그대로 둔다(2026-09-07 결정 유지).
- 원고 내 이미지: writer가 남긴 `[IMAGE: 설명]` + `[IMAGE PROMPT: ...]` 마커 쌍으로 **승인 이후**
  자동 생성한다(`workflows/images/generateManuscriptImages.ts`). 기본은 꺼져 있다 -
  `MANUSCRIPT_IMAGE_GENERATION=true` + `OPENAI_API_KEY`/`GEMINI_API_KEY`가 있어야 실제로 호출한다
  (유료 API라 켜는 것은 사용자 결정). 지금은 `IMAGE_AB_COMPARE=true`로 프롬프트 1개당 OpenAI·Gemini
  양쪽을 만들어 뷰어에 나란히 띄우고, 사용자가 고른 뒤 한쪽으로 고정한다. 생성 이미지는 Supabase
  Storage(`article-images`)가 원본이고 `npm run sync:images`가 맥으로 내려받는다. 옛 경로
  (`ARTICLE_IMAGE_GENERATION` + `workflows/writing/generateArticleImages.ts`, 자체 브리프 생성 후
  본문에 마크다운 삽입)는 계속 false이고 호출하지 않는다 - 지우지는 않았다.
  `IMAGE PROMPT`는 지시문이 아니라 그대로 붙여넣을 수 있는 완성된 문자열이어야 한다
  (`prompts/writing/writer.md` §8).
- 발행: 반자동 업로드(Playwright/API)는 **여전히 중단**이다(2026-09-05). 대신 텔레그램에서 원고를
  승인(✅)하면 `publishPollJob`(`prepareApprovedManuscripts()`)이 Blogspot 배리에이션 원고 1건을
  만들어 `manuscripts/<날짜>/<주제>.md`에 저장하고, 이미지를 생성한 뒤
  `manuscripts/index.html`(날짜→주제 2단 트리, 복사/수정 버튼, 이미지 인라인)을 갱신한다.
  작성 단계 산출물(platform=null article)은 그 자체로 발행되지 않고 배리에이션의 재료로만 쓰인다.
  사용자가 그 페이지에서 복사해 Blogger에 붙여넣는다. 트리거는 2026-09-14부터 폴링이 아니라
  **승인 콜백 직후 이벤트 기반**이다(`docs/ai-handoff/CLOUD_MIGRATION.md` Phase 4) - 로컬 10분
  폴링(`publish-poll` launchd)은 영구 비활성화됐고, GitHub Actions(`job-publish-prepare.yml`)가
  같은 스크립트를 재사용해 실행한다.
- **자동 업로드는 아직 켜지 않는다.** Blogger API v3 + 만료 없는 refresh token은 이미 준비돼
  있지만(`publishArticleToBlogspot.ts`), 켜는 기준은 "원고·이미지 품질이 보장됐다"는 **사용자
  판단**이다. 코드가 준비돼도 사용자 승인 전에는 `BLOGGER_ENABLED`/`BLOGGER_AUTO_PUBLISH`를
  건드리지 않는다. `BLOGGER_PUBLISH_AS_DRAFT`는 true 유지(1단계는 비공개 초안까지).

## 승인 없이는 금지

- Supabase migration 적용 또는 migration history 변경
- 원격/운영 DB insert, update, delete, backfill, cleanup
- Telegram/Kakao 등 외부 메시지 발송 또는 설정 변경
- production 배포, 유료 결제·업그레이드
- 파괴적 Git 작업, 원격 push, merge
- final 6-factor scoring, relevance, clustering 로직 변경

승인이 필요한 작업은 정확한 대상, 영향, 되돌리기 방법, 검증 절차를 먼저 제시한다.

## 현재 핵심 문서

- Blogspot 단독 운영 재설계: `docs/ai-handoff/BLOGSPOT_ONLY_DESIGN.md`
- 진척 원장(데일리 데스크 대시보드가 읽는다): `docs/ai-handoff/PROGRESS.md`
- 상태와 다음 단계: `docs/ai-handoff/CURRENT_STATE.md`
- 폴더·브랜치·배포 흐름: `docs/ai-handoff/WORKFLOW.md`
- 자료조사 규격: `prompts/research/researcher.md`
- 집필 규격: `prompts/writing/writer.md`
- SEO/AEO/GEO 규칙집: `docs/seo-guide.md`
- Codex 위임 양식: `docs/ai-handoff/CODEX_TASK_TEMPLATE.md`
- Codex 위임 스킬: `.claude/skills/delegate-codex/SKILL.md`

문서와 실제 코드가 다르면 실제 저장소 상태를 우선하고 `CURRENT_STATE.md`를 갱신한다. 비밀값이 있는
`.env` 및 세션 프로필은 명시적 필요와 사용자 승인 없이 열거나 출력하지 않는다.
