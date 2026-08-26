// NAVER API credential을 위해 .env를 로드한다. 이 테스트는 saveHistory=false로 Supabase 쓰기를 막는다.
import "dotenv/config";

import { runKeywordRanking } from "./runKeywordRanking.js";

// 실제 NAVER API를 호출하는 테스트이므로 검색어/결과 수를 소량으로 제한한다.
const TEST_QUERIES = ["넷플릭스", "육아지원금", "정부지원금"];
const DISPLAY_PER_QUERY = 5;

async function main() {
  console.log("▶ Keyword Ranking 실제 API 테스트 시작");
  console.log(`검색어: ${TEST_QUERIES.join(", ")} (query당 ${DISPLAY_PER_QUERY}건)`);

  const result = await runKeywordRanking(TEST_QUERIES, {
    displayPerQuery: DISPLAY_PER_QUERY,
    requestDelayMs: 300,
    topN: 10,
    saveHistory: false,
  });

  if (result.summary.historySaved || result.runId !== null) {
    throw new Error("테스트에서 ranking history가 Supabase에 저장되었습니다.");
  }

  console.log("\n▶ 오류 (NAVER API)");
  const errorEntries = Object.entries(result.summary.apiErrors);
  if (errorEntries.length === 0) {
    console.log("없음");
  } else {
    for (const [source, message] of errorEntries) {
      console.log(`- ${source}: ${message}`);
    }
  }

  console.log("\n▶ Ranking history 저장");
  console.log("Supabase persistence: skipped");
  if (result.summary.historyError) {
    console.log(`error: ${result.summary.historyError}`);
  }

  console.log("\n▶ 결과 summary");
  console.log(`검색어: ${result.summary.queries.join(", ")}`);
  console.log(`candidates: ${result.summary.candidatesCount}`);
  console.log(`clusters: ${result.summary.clustersCount}`);
  console.log(`clustering으로 합쳐진 이슈 수(cluster size > 1): ${result.summary.mergedClusterCount}`);
  console.log(
    `score range: ${
      result.summary.scoreRange
        ? `${result.summary.scoreRange.min} ~ ${result.summary.scoreRange.max}`
        : "N/A"
    }`
  );

  console.log("\n▶ Top 랭킹");
  if (result.rankings.length === 0) {
    console.log("결과 없음");
  }
  for (const item of result.rankings) {
    console.log(`\n${item.rank}. [${item.totalScore}점] ${item.keyword}`);
    console.log(`   seedQuery: ${item.seedQuery ?? "N/A"}`);
    console.log(`   headline: ${item.headline}`);
    console.log(`   category: ${item.category}`);
    console.log(`   trend: ${item.trendDirection} (trendScore ${item.scoreBreakdown.trendMomentum})`);
    console.log(`   sources: ${item.sources.join(", ")}`);
    console.log(`   related: ${item.relatedCount}건 / latest: ${item.latestPublishedAt ?? "N/A"}`);
    console.log(`   reason: ${item.reason}`);
    console.log(
      `   breakdown: trend ${item.scoreBreakdown.trendMomentum}, news ${item.scoreBreakdown.newsVelocity}, ` +
        `content ${item.scoreBreakdown.contentDemand}, freshness ${item.scoreBreakdown.freshness}, ` +
        `crossSource ${item.scoreBreakdown.crossSourceSignal}, click ${item.scoreBreakdown.clickPotential}`
    );
  }

  console.log("\n✅ Keyword Ranking 실제 API 테스트 완료");
}

main().catch((error) => {
  console.error("❌ Keyword ranking 테스트 실패:", error.message ?? error);
  process.exit(1);
});
