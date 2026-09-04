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

1. `docs/ai-handoff/CURRENT_STATE.md`를 읽는다.
2. `git status --short --branch`와 최근 커밋을 확인해 문서 이후 변경을 재구성한다.
3. 현재 마일스톤과 이번 작업의 완료 조건을 사용자에게 짧게 알린다.
4. 설계·승인 판단은 직접 수행하고, 반복 작업만 `delegate-codex` 스킬로 위임한다.
5. 변경 후 Claude가 diff를 검토하고 필요한 안전 테스트를 실행한다.
6. 완료·잔여 위험·다음 승인 지점을 사용자에게 보고한다.

## 원고 파이프라인 운영 규칙

- 키워드 승인 → 자료조사 → 집필: `prompts/research/researcher.md` → `prompts/writing/writer.md`가
  규격이다. Claude(리드)는 직접 리서치·집필하지 않고 이 서브 스펙을 호출·조율·감독만 한다.
  헤드리스 실행(`claude -p`)도 이 스펙과 `docs/seo-guide.md`를 로드해 따른다. 산출물은 파일이다
  (`research/[키워드].md`, `drafts/[키워드].md`).
- 자료조사 검색은 하이브리드다. Node가 NAVER API로 기준 sources(감사 베이스라인)를 모으고,
  researcher 에이전트가 WebSearch/WebFetch로 빈칸을 보강한다. 둘 다 `research/*.md`와 `sources`에 남는다.
- 원고 내 이미지: API 자동생성은 **보류**다(`ARTICLE_IMAGE_GENERATION` 기본 false). 생성 코드·
  provider는 유지하되, 당분간 writer가 `[IMAGE: 설명]` + `[IMAGE PROMPT: ...]` 마커 쌍을 남기고
  사용자가 그 프롬프트를 그대로 복사해 AI 생성 도구나 이미지 검색창에 붙여넣어 이미지를 구해
  삽입한 뒤 발행한다(`prompts/writing/writer.md` §8). `IMAGE PROMPT`는 획득 방식에 따라 AI 생성
  프롬프트(영어) 또는 웹 검색 검색어(한국어)이며, 두 경우 모두 지시문이 아니라 그대로 붙여넣을
  수 있는 완성된 문자열이어야 한다. 시스템 안정화 후 자동생성 재개. 불안정기 유료 호출 회피가 목적.
- Blogspot: **임시저장(draft)까지만** 진행한다. 원고를 draft로 두면 사용자가 이미지 삽입 후 직접
  발행한다. `BLOGGER_PUBLISH_AS_DRAFT=false`로 바꾸지 않는다. (네이버·티스토리도 임시저장까지만)

## 승인 없이는 금지

- Supabase migration 적용 또는 migration history 변경
- 원격/운영 DB insert, update, delete, backfill, cleanup
- Telegram/Kakao 등 외부 메시지 발송 또는 설정 변경
- production 배포, 유료 결제·업그레이드
- 파괴적 Git 작업, 원격 push, merge
- final 6-factor scoring, relevance, clustering 로직 변경

승인이 필요한 작업은 정확한 대상, 영향, 되돌리기 방법, 검증 절차를 먼저 제시한다.

## 현재 핵심 문서

- 상태와 다음 단계: `docs/ai-handoff/CURRENT_STATE.md`
- 자료조사 규격: `prompts/research/researcher.md`
- 집필 규격: `prompts/writing/writer.md`
- SEO/AEO/GEO 규칙집: `docs/seo-guide.md`
- Codex 위임 양식: `docs/ai-handoff/CODEX_TASK_TEMPLATE.md`
- Codex 위임 스킬: `.claude/skills/delegate-codex/SKILL.md`

문서와 실제 코드가 다르면 실제 저장소 상태를 우선하고 `CURRENT_STATE.md`를 갱신한다. 비밀값이 있는
`.env` 및 세션 프로필은 명시적 필요와 사용자 승인 없이 열거나 출력하지 않는다.
