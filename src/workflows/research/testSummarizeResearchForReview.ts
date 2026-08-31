// summarizeResearchFile / buildResearchSummary 테스트.
// 2026-09-01 재작성: LLM 호출 없이 research 파일을 결정적으로 요약 텍스트로 옮긴다.

import { buildResearchSummary, summarizeResearchFile } from "./summarizeResearchForReview.js";
import { parseResearchFile } from "./parseResearchFile.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const FILE = `---
keyword: 2026 경복궁 별빛야행
topic: living
researched_at: 2026-09-01
source_counts:
  official: 2
  medical: 0
  news: 1
  community: 3
verdict: thin
---

# 2026 경복궁 별빛야행

## 1. 요약

예매권 추첨 응모(8/14~8/20)와 당첨자 발표(8/24)가 모두 지났다. 도슭수라상 가격은 1인 6만 원이다.

## 4. 확인되지 않은 통설

- 현장 대기줄로 입장 가능하다는 후기가 있음
`;

function main(): void {
  console.log("▶ summarizeResearchFile 테스트 시작\n");

  const s = summarizeResearchFile(FILE);
  assert(s.verdict === "thin", `verdict 전달 (실제: ${s.verdict})`);
  assert(s.text.includes("verdict: thin"), "verdict 배지 줄이 있어야 한다");
  assert(s.text.includes("근거 6건"), `근거 합계 줄 (실제 text: ${s.text})`);
  assert(s.text.includes("공공 2") && s.text.includes("커뮤니티 3"), "등급별 건수");
  assert(s.text.includes("당첨자 발표"), "§1 요약 본문이 그대로 들어가야 한다");
  assert(s.text.includes("확인되지 않은 통설"), "§4 통설 경고 블록");
  assert(s.text.includes("현장 대기줄"), "통설 항목 내용");
  console.log("✅ verdict + 근거 구성 + §1 요약 + §4 통설이 요약 텍스트에 포함됨");

  // blocked verdict
  const blocked = buildResearchSummary(
    parseResearchFile("---\nkeyword: x\nverdict: blocked\n---\n## 1. 요약\n근거가 커뮤니티뿐이다.")
  );
  assert(blocked.verdict === "blocked", "blocked verdict 전달");
  assert(blocked.text.includes("보류"), "blocked면 '보류' 문구");
  console.log("✅ blocked verdict -> 보류 안내");

  // 통설 없으면 블록도 없다
  const noClaims = summarizeResearchFile("---\nkeyword: x\nverdict: ok\n---\n## 1. 요약\n확인된 사실만 있음.");
  assert(!noClaims.text.includes("확인되지 않은 통설"), "통설이 없으면 블록도 없어야 한다");
  console.log("✅ 통설 없음 -> 경고 블록 생략");

  console.log("\n✅ summarizeResearchFile 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
