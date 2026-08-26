import { runNaverKeywordDiscovery } from "./runNaverKeywordDiscovery.js";

// 실제 NAVER API를 호출하는 테스트이므로 검색어/결과 수를 소량으로 제한한다.
const TEST_QUERIES = ["넷플릭스", "육아지원금"];
const DISPLAY_PER_QUERY = 5;

async function main() {
  console.log("▶ Naver Keyword Discovery 실제 API 테스트 시작");
  console.log(`검색어: ${TEST_QUERIES.join(", ")} (query당 ${DISPLAY_PER_QUERY}건)`);

  const summary = await runNaverKeywordDiscovery(TEST_QUERIES, {
    displayPerQuery: DISPLAY_PER_QUERY,
    requestDelayMs: 300,
  });

  console.log("\n▶ 호출 성공한 API");
  console.log(
    summary.apiCallsSucceeded.length > 0 ? summary.apiCallsSucceeded.join(", ") : "없음"
  );

  console.log("\n▶ 오류");
  const errorEntries = Object.entries(summary.apiErrors);
  if (errorEntries.length === 0) {
    console.log("없음");
  } else {
    for (const [source, message] of errorEntries) {
      console.log(`- ${source}: ${message}`);
    }
  }

  console.log("\n▶ 결과 summary");
  console.log(`검색어: ${summary.queries.join(", ")}`);
  console.log(`수집 건수: ${summary.fetched}`);
  console.log(`중복 제거 건수: ${summary.duplicateInBatch}`);
  console.log(`DB 기존 존재(24시간 내): ${summary.existingInDb}`);
  console.log(`DB 신규 저장 건수: ${summary.inserted}`);

  if (summary.insertedKeywords.length > 0) {
    console.log("\n▶ 신규 저장된 keyword");
    for (const row of summary.insertedKeywords) {
      console.log(
        `- [${row.id}] ${row.keyword} (source: ${row.source}, category: ${row.category}, score: ${row.trend_score})`
      );
    }
  }

  console.log("\n✅ Naver Keyword Discovery 실제 API 테스트 완료");
}

main().catch((error) => {
  console.error("❌ Naver keyword discovery 테스트 실패:", error.message ?? error);
  process.exit(1);
});
