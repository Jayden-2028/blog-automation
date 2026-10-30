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

  // ── 2026-10-30 회귀: 본문은 실제 주소, grounding은 리디렉션 주소 ──────────────
  // 옛 코드는 둘을 글자 그대로 비교해 grounding된 공식 출처까지 전부 강등했다(실측 10/10).
  // 이제 호출자가 리디렉션을 푼 **최종 주소**를 넘기므로 일치해야 한다.
  const REAL_SAMPLE = `---
keyword: 지역 특산품
topic: kscene
researched_at: 2026-10-30
source_counts:
  official: 2
  medical: 0
  news: 0
  community: 0
verdict: ok
---

## 2. 확인된 사실

- [official] 문체부는 전통시장 10곳을 K-관광 마켓으로 선정했다 — 확인일 2026-10-30
  · 출처: https://www.korea.kr/news/policyNewsView.do?newsId=148914101

- [official] 농사로에 지역 특산물 1,721개가 등록돼 있다 — 확인일 2026-10-30
  · 출처: https://www.nongsaro.go.kr/portal/ps/psa/psae/psaeg/localSpecialitiesLst.ps?menuId=PS00012

- [official] 관계 부처가 발표했다 — 확인일 2026-10-30
  · 출처: https://www.msit.go.kr

## 10. 전체 출처 목록

| # | 등급 | 제목 | URL | 발행일 |
|---|---|---|---|---|
| 1 | official | K-관광 마켓 | https://www.korea.kr/news/policyNewsView.do?newsId=148914101 | 2023-05-03 |
| 2 | official | 농사로 특산물 | https://www.nongsaro.go.kr/portal/ps/psa/psae/psaeg/localSpecialitiesLst.ps?menuId=PS00012 | 2024-01-01 |
| 3 | official | 부처 발표 | https://www.msit.go.kr | 발행일 미상 |
`;

  // 리디렉션을 푼 최종 주소 1건 + 못 푼 출처의 도메인 1건
  const resolvedUrls = new Set(["https://korea.kr/news/policyNewsView.do?newsId=148914101"]);
  const resolvedDomains = new Set(["korea.kr", "nongsaro.go.kr"]);

  const real = enforceGeminiGroundingUrls(REAL_SAMPLE, resolvedUrls, resolvedDomains);
  assert(
    real.text.includes("[official] 문체부는 전통시장"),
    "최종 주소가 일치하면 official을 유지해야 한다(리디렉션 비교 회귀)"
  );
  assert(
    real.text.includes("[official] 농사로에 지역 특산물"),
    "리디렉션을 못 푼 출처는 도메인 + 경로로 인정한다"
  );
  assert(real.domainMatchedCount >= 1, `도메인 일치 건수를 보고해야 한다 (실제: ${real.domainMatchedCount})`);
  assert(
    !real.text.includes("[official] 관계 부처가 발표"),
    "최상위 도메인만 적은 출처는 도메인 폴백으로도 인정하지 않는다(2026-09-03 가드 유지)"
  );
  assert(real.downgradedCount === 2, `msit.go.kr 불릿 + 표 1행만 강등 (실제: ${real.downgradedCount})`);
  console.log("✅ 실제 주소 ↔ 리디렉션 해제 매칭 + 도메인 폴백 + 최상위 도메인 거부");


  console.log("\n✅ enforceGeminiGroundingUrls 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
