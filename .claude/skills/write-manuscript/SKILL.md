---
name: write-manuscript
description: 블로그 원고를 대화형으로 직접 쓰거나 고칠 때 쓴다. 파이프라인(클라우드·맥 헤드리스)과 같은 규격 파일을 같은 순서로 읽어 같은 원고가 나오게 한다.
---

# 원고 작성 (대화형)

계정 레벨 스킬(`parenting/entertainment/trend-blog-writer`)은 쓰지 않는다. 규격의 원본은 이 저장소다.

1. `research/<키워드>.md`가 있는지 확인한다. 없으면 `prompts/research/researcher.md`대로 먼저 조사한다.
2. 읽을 파일과 순서는 `src/workflows/writing/specFiles.ts`의 `writingSpecFiles(category)`가 정한다.
   요약하면: `prompts/writing/core-rules.md`(가장 먼저, 충돌 시 최우선) → `writer.md` →
   `rules/facts-and-hedging.md` → `style/voice.md`(incident는 `style/incident.md`) →
   카테고리 `style/*.md` → `rules/article-structure.md` → `rules/topic-allocation.md` →
   `rules/output-format.md` → `docs/seo-guide.md`.
3. 전부 읽은 뒤에 쓴다. 산출물은 `drafts/<키워드>.md`(형식은 `output-format.md` §9).
4. 저장 전 `core-rules.md` §6 체크리스트를 통과시킨다.
5. 검증: `npx tsx -e "import('./src/workflows/writing/enforceWritingRules.js').then(m=>console.log(m.findRuleViolations(require('fs').readFileSync('drafts/<키워드>.md','utf8'))))"`
   로 남은 금지 표현을 확인한다(0건이어야 한다).
