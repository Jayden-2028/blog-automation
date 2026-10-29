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
  assert(s.text.includes("당첨자 발표"), "§1 요약 본문이 그대로 들어가야 한다");
  console.log("✅ verdict + §1 요약이 요약 텍스트에 포함됨");

  // 근거 건수(등급별 breakdown)와 §4 확인되지 않은 통설은 메시지에서 뺀다(2026-09-04 사용자 요청 -
  // 헤더의 sourceCounts와 중복이었고, 두 계산이 서로 다른 값을 낸 것도 실측에서 확인됨).
  assert(!s.text.includes("근거 6건"), `근거 건수 줄이 없어야 한다 (실제 text: ${s.text})`);
  assert(!s.text.includes("공공 2") && !s.text.includes("커뮤니티 3"), "등급별 건수도 없어야 한다");
  assert(!s.text.includes("확인되지 않은 통설"), "§4 통설 경고 블록이 없어야 한다");
  assert(!s.text.includes("현장 대기줄"), "통설 항목 내용도 없어야 한다");
  console.log("✅ 근거 건수 + §4 통설 블록 제거");

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

  // 로컬 재료 0(2026-10-30) - kscene에서 §12가 비면 검수 카드에 한 줄 띄운다. verdict는 그대로다.
  const ksceneEmpty = "---\nkeyword: korea food waste\ntopic: kscene\nlocal_practice_rows: 0\nverdict: ok\n---\n## 1. 요약\n절차 확인됨.";
  const warned = summarizeResearchFile(ksceneEmpty, "kscene");
  assert(warned.text.includes("로컬 재료 0"), `로컬 재료 0 줄 없음 (${warned.text})`);
  assert(warned.verdict === "ok", "로컬 재료 0이 verdict를 바꾸면 안 된다");

  const withRows = summarizeResearchFile(
    "---\nkeyword: k\ntopic: kscene\nlocal_practice_rows: 2\nverdict: ok\n---\n## 1. 요약\n절차 확인됨.",
    "kscene"
  );
  assert(!withRows.text.includes("로컬 재료 0"), "관행이 있는데 경고가 떴다");

  // 다른 트랙은 §12가 없어 rows가 0이지만 이 줄을 띄우지 않는다.
  const otherTrack = summarizeResearchFile("---\nkeyword: k\ntopic: 영유아 수면\nverdict: ok\n---\n## 1. 요약\n내용", "parenting");
  assert(!otherTrack.text.includes("로컬 재료 0"), "다른 트랙에 로컬 재료 경고가 떴다");
  // category를 안 넘기면 frontmatter topic으로 판정한다(폴백).
  assert(summarizeResearchFile(ksceneEmpty).text.includes("로컬 재료 0"), "topic 폴백 판정 실패");
  console.log("✅ kscene 로컬 재료 0 표시(verdict 불변 · 다른 트랙 불변)");

  console.log("\n✅ summarizeResearchFile 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
