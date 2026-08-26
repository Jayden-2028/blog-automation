// seed query / trend signal이 파이프라인 각 단계(NAVER Trend API -> fetchTrendMomentum -> candidate
// metadata -> clustering -> aggregateClusterSignals -> scoreKeyword)를 거치며 유실되지 않는지 추적한다.
// saveRankingHistory 단계는 이미 scoreBreakdown.trendMomentum 값을 그대로 trend_score 컬럼에 매핑하는
// 단순 복사이므로(saveRankingHistory.ts 참고), 여기서는 그 앞 단계까지의 신호 보존만 검증하고
// 실제 DB 저장 결과 확인은 npm run test:ranking(Part C)으로 별도 수행한다.
// secret은 출력하지 않는다.
// 실행: npm run debug:pipeline

import "dotenv/config";

import { collectNaverCandidates } from "../../keyword-discovery/collectNaverCandidates.js";
import { aggregateClusterSignals } from "../aggregateClusterSignals.js";
import { CompositeSimilarityClusterer } from "../clustering/CompositeSimilarityClusterer.js";
import { fetchTrendMomentumByQuery } from "../fetchTrendMomentum.js";
import { scoreKeyword } from "../scoreKeyword.js";

const SEED_QUERIES = ["넷플릭스", "육아지원금"];
const DISPLAY_PER_QUERY = 5;

async function main() {
  console.log("▶ Keyword Ranking 파이프라인 seed query 추적");
  console.log(`seed queries: ${SEED_QUERIES.join(", ")} (query당 ${DISPLAY_PER_QUERY}건)`);

  // 1) NAVER Trend API -> fetchTrendMomentum
  const { momentumByQuery, succeeded: trendSucceeded } = await fetchTrendMomentumByQuery(SEED_QUERIES, {
    rangeDays: 14,
  });
  console.log(`\n[1] fetchTrendMomentum: 성공=${trendSucceeded}, momentum 확보된 query 수=${momentumByQuery.size}`);
  for (const seedQuery of SEED_QUERIES) {
    console.log(`    - ${seedQuery}: ${momentumByQuery.has(seedQuery) ? "momentum 있음" : "momentum 없음"}`);
  }

  // 2) candidate metadata (naver_news/blog/web 수집 결과에 seed query가 그대로 남아있는지)
  const collected = await collectNaverCandidates(SEED_QUERIES, { displayPerQuery: DISPLAY_PER_QUERY });
  console.log(`\n[2] candidate 수집: 총 ${collected.candidates.length}건`);
  for (const seedQuery of SEED_QUERIES) {
    const count = collected.candidates.filter((c) => c.metadata.query === seedQuery).length;
    console.log(`    - metadata.query === "${seedQuery}": ${count}건`);
  }
  const missingQueryMeta = collected.candidates.filter((c) => typeof c.metadata.query !== "string").length;
  console.log(`    - metadata.query 유실된 candidate: ${missingQueryMeta}건`);

  // 3) clustering (cluster.items가 원본 candidate의 metadata.query를 그대로 보존하는지)
  const clusterer = new CompositeSimilarityClusterer();
  const clusters = clusterer.cluster(collected.candidates);
  console.log(`\n[3] clustering: ${collected.candidates.length}건 -> ${clusters.length}개 cluster`);
  const clusterQueryLoss = clusters.filter((cluster) =>
    cluster.items.some((item) => typeof item.metadata.query !== "string")
  ).length;
  console.log(`    - metadata.query가 없는 item을 포함한 cluster: ${clusterQueryLoss}개`);

  // 4) aggregateClusterSignals (seedQuery 선택 + trend 필드 연결)
  const inputs = clusters.map((cluster) => aggregateClusterSignals(cluster, momentumByQuery));
  const withSeedQuery = inputs.filter((input) => input.seedQuery !== null).length;
  const withTrendData = inputs.filter((input) => input.trendLatestRatio !== null).length;
  console.log(`\n[4] aggregateClusterSignals: ${inputs.length}개 cluster`);
  console.log(`    - seedQuery 연결됨: ${withSeedQuery}/${inputs.length}`);
  console.log(`    - trend 데이터(trendLatestRatio) 연결됨: ${withTrendData}/${inputs.length}`);
  const mixedSeedClusters = inputs.filter((input) => input.seedQuerySelectionNote !== null);
  if (mixedSeedClusters.length > 0) {
    console.log(`    - 여러 seed query가 섞여 대표 query를 선택한 cluster: ${mixedSeedClusters.length}개`);
    for (const input of mixedSeedClusters) {
      console.log(`      · "${input.headline}" -> ${input.seedQuerySelectionNote}`);
    }
  }

  // 5) scoreKeyword (trend 데이터가 있는 cluster의 trendMomentum 점수가 실제로 0이 아닌지)
  console.log(`\n[5] scoreKeyword`);
  for (const input of inputs) {
    const breakdown = scoreKeyword(input);
    console.log(
      `    - [${input.seedQuery ?? "N/A"}] "${input.keyword}" trend=${input.trendDirection} ` +
        `latest=${input.trendLatestRatio?.toFixed(2) ?? "N/A"} previous=${input.trendPreviousRatio?.toFixed(2) ?? "N/A"} ` +
        `deltaPercent=${input.trendDeltaPercent?.toFixed(2) ?? "N/A"}% midChangePercent=${input.trendShortTermChangePercent?.toFixed(2) ?? "N/A"}% ` +
        `-> trendScore=${breakdown.trendMomentum}`
    );
  }

  console.log("\n✅ 파이프라인 추적 완료 (saveRankingHistory 단계 검증은 npm run test:ranking 참고)");
}

main().catch((error) => {
  console.error("❌ 파이프라인 추적 실패:", error.message ?? error);
  process.exit(1);
});
