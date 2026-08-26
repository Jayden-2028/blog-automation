// NAVER Search Trend API 원시 응답이 실제로 어떤 momentum 신호를 만들어내는지 확인하기 위한 디버그 스크립트.
// secret(NAVER_CLIENT_ID/SECRET)은 절대 출력하지 않는다 — 아래에서 찍는 값은 seed query와 ratio 숫자뿐이다.
// 실행: npm run debug:trend

import "dotenv/config";

import { fetchTrendMomentumByQuery } from "../fetchTrendMomentum.js";
import { computeTrendMomentumScore } from "../scoreKeyword.js";
import { computeTrendDeltaPercent, resolveTrendDirection } from "../aggregateClusterSignals.js";

const SEED_QUERIES = ["넷플릭스", "육아지원금", "정부지원금"];

async function main() {
  console.log("▶ NAVER Search Trend momentum 디버그");
  console.log(`seed queries: ${SEED_QUERIES.join(", ")}`);

  const { momentumByQuery, succeeded, error } = await fetchTrendMomentumByQuery(SEED_QUERIES, {
    rangeDays: 14,
  });

  console.log(`\ntrend API 성공 여부: ${succeeded}`);
  if (error) console.log(`(마지막 에러: ${error})`);

  for (const seedQuery of SEED_QUERIES) {
    const momentum = momentumByQuery.get(seedQuery);
    console.log(`\n--- seedQuery: ${seedQuery} ---`);

    if (!momentum) {
      console.log("momentum 없음 (해당 query에 대한 trend 데이터를 못 받음)");
      continue;
    }

    const delta =
      momentum.previousRatio !== null ? momentum.latestRatio - momentum.previousRatio : null;
    const deltaPercent = computeTrendDeltaPercent(momentum.latestRatio, momentum.previousRatio);
    const trendDirection = resolveTrendDirection(deltaPercent, momentum.shortTermChangePercent);
    const trendScore = computeTrendMomentumScore(deltaPercent, momentum.shortTermChangePercent);

    console.log(`recentValues: [${momentum.recentValues.map((v) => v.toFixed(4)).join(", ")}]`);
    console.log(`latest: ${momentum.latestRatio.toFixed(4)}`);
    console.log(`previous: ${momentum.previousRatio?.toFixed(4) ?? "N/A"}`);
    console.log(`delta: ${delta !== null ? delta.toFixed(4) : "N/A"}`);
    console.log(`deltaPercent: ${deltaPercent !== null ? `${deltaPercent.toFixed(2)}%` : "N/A"}`);
    console.log(`shortAverage(최근 3구간): ${momentum.shortAverage?.toFixed(4) ?? "N/A"}`);
    console.log(`previousAverage(그 이전 3구간): ${momentum.previousAverage?.toFixed(4) ?? "N/A"}`);
    console.log(
      `shortTermChangePercent(중기): ${
        momentum.shortTermChangePercent !== null ? `${momentum.shortTermChangePercent.toFixed(2)}%` : "N/A"
      }`
    );
    console.log(`slope(ratio/일, 참고용): ${momentum.slope?.toFixed(4) ?? "N/A"}`);
    console.log(`trendDirection: ${trendDirection}`);
    console.log(`trendScore(0~30): ${trendScore}`);
  }

  console.log("\n✅ trend momentum 디버그 완료");
}

main().catch((error) => {
  console.error("❌ trend momentum 디버그 실패:", error.message ?? error);
  process.exit(1);
});
