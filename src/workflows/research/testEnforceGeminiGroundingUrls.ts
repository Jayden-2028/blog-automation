// enforceGeminiGroundingUrls 테스트. grounding 안 된 official/medical URL을 community로
// 강등하고, frontmatter verdict/source_counts를 재계산하는지 확인한다.

import { enforceGeminiGroundingUrls } from "./enforceGeminiGroundingUrls.js";
import { parseResearchFile } from "./parseResearchFile.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SAMPLE = `---
keyword: 2026년 추석 연휴 기간
topic: living
researched_at: 2026-09-03
source_counts:
  official: 2
  medical: 0
  news: 1
  community: 1
verdict: ok
---

# 2026년 추석 연휴 기간

## 1. 요약

추석 연휴 안내.

## 2. 확인된 사실

- [official] 2026년 추석 당일은 9월 25일이다 — 확인일 2026-09-03
  · 출처: https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA1

- [official] 우주항공청이 발표한 공휴일 수는 70일이다 — 확인일 2026-09-03
  · 출처: https://www.msit.go.kr

## 3. 보도로만 확인된 내용

- [news] 대체공휴일이 없다는 보도가 있다 — 확인일 2026-09-03
  · 출처: https://news.example.com/a

## 4. 확인되지 않은 통설

> 커뮤니티에만 있는 내용.

- 연차 3일 붙이면 9일 쉰다는 말이 있음
  · 출처: https://blog.example.com/b

## 10. 전체 출처 목록

| # | 등급 | 제목 | URL | 발행일 |
|---|---|---|---|---|
| 1 | official | 추석 당일 안내 | https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA1 | 2026-09-03 |
| 2 | official | 공휴일 수 발표 | https://www.msit.go.kr | 발행일 미상 |
| 3 | news | 대체공휴일 보도 | https://news.example.com/a | 2026-09-01 |
| 4 | community | 연차 계산 블로그 | https://blog.example.com/b | 발행일 미상 |
`;

function main(): void {
  console.log("▶ enforceGeminiGroundingUrls 테스트 시작\n");

  const allowedUrls = new Set([
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA1",
    "https://news.example.com/a",
    "https://blog.example.com/b",
  ]);

  const result = enforceGeminiGroundingUrls(SAMPLE, allowedUrls);

  assert(result.downgradedCount === 2, `grounding 안 된 official 2건(불릿 1 + 표 1행) 강등 (실제: ${result.downgradedCount})`);
  assert(result.text.includes("grounding 미확인"), "강등된 불릿에 표시가 붙어야 한다");
  assert(!result.text.includes("[official] 우주항공청이 발표"), "강등된 불릿은 더 이상 [official] 태그를 달지 않는다");
  console.log("✅ grounding 안 된 official URL -> community 강등(§2 불릿)");

  const parsed = parseResearchFile(result.text);
  const table = parsed.sourceTable;
  const msitRow = table.find((r) => r.url === "https://www.msit.go.kr");
  assert(msitRow?.authority === "community", `§10 표의 msit.go.kr 행도 community로 강등 (실제: ${msitRow?.authority})`);
  const groundedRow = table.find((r) => r.url?.includes("grounding-api-redirect"));
  assert(groundedRow?.authority === "official", "grounding된 URL은 official 유지");
  console.log("✅ §10 표에서도 동일하게 강등");

  // 강등 후 official+medical=1(<2)이지만 news=1(<3), total=4(<5) -> blocked
  assert(result.recomputedVerdict === "blocked", `강등 후 verdict 재계산 (실제: ${result.recomputedVerdict})`);
  assert(parsed.verdict === "blocked", "frontmatter verdict도 재계산된 값으로 다시 써야 한다");
  assert(
    result.recomputedSourceCounts.official === 1 && result.recomputedSourceCounts.community === 2,
    `recomputedSourceCounts (실제: ${JSON.stringify(result.recomputedSourceCounts)})`
  );
  console.log("✅ frontmatter verdict/source_counts 재계산 + 재기록");

  // 전부 grounding된 경우 원문 그대로(강등 없음)
  const allGroundedAllowed = new Set([
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA1",
    "https://www.msit.go.kr",
    "https://news.example.com/a",
    "https://blog.example.com/b",
  ]);
  const untouched = enforceGeminiGroundingUrls(SAMPLE, allGroundedAllowed);
  assert(untouched.downgradedCount === 0, "전부 허용 목록에 있으면 강등 없음");
  assert(untouched.text === SAMPLE, "강등이 없으면 원문을 그대로 반환한다(불필요한 재작성 없음)");
  console.log("✅ 전부 grounding된 경우 원문 보존");

  console.log("\n✅ enforceGeminiGroundingUrls 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
