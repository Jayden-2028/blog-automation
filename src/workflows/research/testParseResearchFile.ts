// parseResearchFile 테스트. researcher.md §7 규격 파일을 파싱한다.

import { parseResearchFile } from "./parseResearchFile.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SAMPLE = `---
keyword: 아기 밤중수유 끊는 시기
topic: 영유아 수면
researched_at: 2026-09-01
source_counts:
  official: 2
  medical: 3
  news: 1
  community: 5
verdict: ok
---

# 아기 밤중수유 끊는 시기

## 1. 요약

만 6개월 이후부터 야간 수유 중단을 고려할 수 있다는 것이 공식·의료기관 자료의 공통된 설명이다.
체중이 정상 범위여야 한다는 조건이 붙는다.

## 2. 확인된 사실

- [official] 만 6개월 이후 야간 수유 없이 수면 가능 — 확인일 2026-09-01
  · 출처: https://health.kdca.go.kr/a

## 4. 확인되지 않은 통설

> 아래는 커뮤니티에만 존재한다.

- "100일 지나면 저절로 끊긴다"는 말이 자주 보임
- 분유가 모유보다 오래 간다는 속설

## 10. 전체 출처 목록

| # | 등급 | 제목 | URL | 발행일 |
|---|---|---|---|---|
| 1 | official | 질병관리청 영유아 수면 안내 | https://health.kdca.go.kr/a | 2025-11-20 |
| 2 | medical | 서울아산병원 수유 상담 | https://amc.seoul.kr/b | 2024-03-11 |
| 3 | community | 맘카페 후기 모음 | https://cafe.naver.com/c | 발행일 미상 |
`;

function main(): void {
  console.log("▶ parseResearchFile 테스트 시작\n");

  const p = parseResearchFile(SAMPLE);

  assert(p.keyword === "아기 밤중수유 끊는 시기", `keyword 파싱 (실제: ${p.keyword})`);
  assert(p.topic === "영유아 수면", "topic 파싱");
  assert(p.verdict === "ok", `verdict 파싱 (실제: ${p.verdict})`);
  assert(p.sourceCounts.official === 2 && p.sourceCounts.community === 5, `source_counts 중첩 파싱 (실제: ${JSON.stringify(p.sourceCounts)})`);
  console.log("✅ frontmatter(keyword/topic/verdict/source_counts) 파싱");

  assert(p.summary.includes("만 6개월 이후"), "§1 요약 본문 추출");
  assert(!p.summary.includes("## 2."), "요약에 다음 섹션 헤더가 섞이지 않음");
  console.log("✅ §1 요약 추출");

  assert(p.unverifiedClaims.length === 2, `§4 통설 항목 2개 (실제: ${p.unverifiedClaims.length})`);
  assert(p.unverifiedClaims[0].includes("100일"), "첫 통설 항목 내용");
  console.log("✅ §4 확인되지 않은 통설 추출");

  assert(p.sourceTable.length === 3, `§10 출처 표 3행 (실제: ${p.sourceTable.length})`);
  assert(p.sourceTable[0].authority === "official" && p.sourceTable[0].url === "https://health.kdca.go.kr/a", "1행 등급/URL");
  assert(p.sourceTable[2].authority === "community", "3행 등급");
  assert(p.sourceTable[2].publishedAt === "발행일 미상", "발행일 미상도 그대로 보존");
  console.log("✅ §10 전체 출처 목록 표 파싱");

  // verdict 누락 시 thin으로 폴백
  const noVerdict = parseResearchFile("---\nkeyword: x\n---\n## 1. 요약\n내용");
  assert(noVerdict.verdict === "thin", "verdict 누락 -> thin 폴백");
  // frontmatter 없는 파일도 죽지 않는다
  const noFm = parseResearchFile("# 제목\n본문만 있음");
  assert(noFm.verdict === "thin" && noFm.sourceTable.length === 0, "frontmatter 없어도 안전");
  console.log("✅ verdict 누락/frontmatter 없음 -> 안전한 기본값");

  // researcher.md §7 템플릿의 `verdict: ok        # ok | thin | blocked`처럼 인라인 주석을
  // 남기는 실제 사례가 있었다(2026-09-03, Claude 실측) - 주석 때문에 ok가 thin으로 오분류됐었다.
  const inlineComment = parseResearchFile("---\nkeyword: x\nverdict: ok        # ok | thin | blocked\n---\n## 1. 요약\n내용");
  assert(inlineComment.verdict === "ok", `verdict 인라인 주석 무시 (실제: ${inlineComment.verdict})`);
  console.log("✅ verdict 인라인 주석(# ...) 무시하고 값만 파싱");

  // §12 현지 관행(2026-10-30, kscene 로컬 정체성 개정). frontmatter 키가 있으면 그 값, 없으면 표를 센다.
  const withRows = parseResearchFile(
    "---\nkeyword: korea food waste\ntopic: kscene\nlocal_practice_rows: 3\nverdict: ok\n---\n## 1. 요약\n내용"
  );
  assert(withRows.localPracticeRows === 3, `local_practice_rows 파싱 (실제: ${withRows.localPracticeRows})`);

  const countedTable = parseResearchFile(
    [
      "---",
      "keyword: korea food waste",
      "topic: kscene",
      "verdict: ok",
      "---",
      "## 12. 현지 관행 (Local practice)",
      "",
      "| 구분 | 내용 | 범위 | 근거 URL | 등급 | 확인일 |",
      "|---|---|---|---|---|---|",
      "| 관행 | 종량기에 카드를 찍는다 | 수도권 대단지 | https://a | community | 2026-10-30 |",
      "| 오해 | 일반 쓰레기와 같이 버리는 줄 안다 | 레딧 | https://b | community | 2026-10-30 |",
      "",
      "## 10. 전체 출처 목록",
      "",
      "| # | 등급 | 제목 | URL | 발행일 |",
      "|---|---|---|---|---|",
      "| 1 | official | 안내 | https://c | 2026-01-01 |",
    ].join("\n")
  );
  assert(countedTable.localPracticeRows === 2, `§12 표 행 수 폴백 (실제: ${countedTable.localPracticeRows})`);
  assert(countedTable.sourceTable.length === 1, "§12 추가가 §10 출처 표 파싱을 깨지 않는다");

  const missing = parseResearchFile(
    "---\nkeyword: x\ntopic: kscene\nverdict: ok\n---\n## 12. 현지 관행 (Local practice)\n\n관행 미확보 - 한글 질의 3회"
  );
  assert(missing.localPracticeRows === 0, "관행 미확보 -> 0");
  // §12이 없는 다른 트랙 조사는 0이고, 새 키가 없어도 파서가 깨지지 않는다(기존 파일 호환).
  const legacy = parseResearchFile("---\nkeyword: x\ntopic: 영유아 수면\nverdict: ok\n---\n## 1. 요약\n내용");
  assert(legacy.localPracticeRows === 0 && legacy.verdict === "ok", "§12 없는 기존 파일 호환");
  console.log("✅ §12 현지 관행 행 수(frontmatter 우선 · 표 폴백 · 미확보 0 · 기존 파일 호환)");

  console.log("\n✅ parseResearchFile 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
