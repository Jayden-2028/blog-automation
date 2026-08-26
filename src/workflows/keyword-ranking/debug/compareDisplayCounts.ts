// query당 displayPerQuery를 5 vs 20으로 늘렸을 때 candidates/clusters/multi-source cluster 수/
// crossSource 점수가 있는 cluster 수/Top 10 score range가 어떻게 달라지는지 비교한다.
// API 호출량 통제를 위해 seed query 2개, 두 번의 run만 수행하고 history는 저장하지 않는다(saveHistory:false).
// 실행: npm run debug:compare-display

import "dotenv/config";

import { runKeywordRanking } from "../runKeywordRanking.js";

const SEED_QUERIES = ["넷플릭스", "육아지원금"];
const DISPLAY_COUNTS = [5, 20];

function countMultiSourceClusters(rankings: Awaited<ReturnType<typeof runKeywordRanking>>["rankings"]) {
  return rankings.filter((item) => item.sources.length >= 2).length;
}

function countCrossSourceScored(rankings: Awaited<ReturnType<typeof runKeywordRanking>>["rankings"]) {
  return rankings.filter((item) => item.scoreBreakdown.crossSourceSignal > 0).length;
}

async function main() {
  console.log("▶ displayPerQuery 5 vs 20 비교 테스트");
  console.log(`seed queries: ${SEED_QUERIES.join(", ")}`);

  for (const displayPerQuery of DISPLAY_COUNTS) {
    console.log(`\n=== displayPerQuery = ${displayPerQuery} ===`);
    const result = await runKeywordRanking(SEED_QUERIES, {
      displayPerQuery,
      requestDelayMs: 300,
      topN: 10,
      saveHistory: false,
    });

    console.log(`candidates: ${result.summary.candidatesCount}`);
    console.log(`clusters: ${result.summary.clustersCount}`);
    console.log(`multi-source clusters(sources>=2) in Top10: ${countMultiSourceClusters(result.rankings)}`);
    console.log(`crossSource score > 0 in Top10: ${countCrossSourceScored(result.rankings)}`);
    console.log(
      `Top10 score range: ${
        result.summary.scoreRange
          ? `${result.summary.scoreRange.min} ~ ${result.summary.scoreRange.max}`
          : "N/A"
      }`
    );
  }

  console.log("\n✅ 비교 테스트 완료 (history는 저장하지 않음)");
}

main().catch((error) => {
  console.error("❌ 비교 테스트 실패:", error.message ?? error);
  process.exit(1);
});
