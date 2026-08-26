// "Daily Ranking Quality Gate" 실제 검증용 dry-run 스크립트.
// active seed_queries 테이블 전체(운영 시점 기준 44개)를 대상으로 실제 NAVER API를 호출해
// dailyKeywordWorkflow 전체(seed -> collect -> relevance filter -> cluster -> rank(+diversity) -> save)를
// 1회 실행하고, Telegram은 dryRun으로만 preview를 뽑는다(실제 발송 없음).
//
// 확인 항목: active seed 수 / candidates / relevance filter 전후 후보 수 / clusters /
// category 분포 / seedQuery 분포 / Top10 / Top10 내 동일 seed 최대 등장 횟수 / Telegram preview.
import "dotenv/config";

import { runDailyKeywordWorkflow } from "./dailyKeywordWorkflow.js";
import { SeedQueryRepository } from "../repositories/SeedQueryRepository.js";
import type { RankedKeyword } from "../types/keywordScoring.js";
import { resolveClusterAttribution } from "./keyword-ranking/clusterAttribution.js";
import { diagnoseClusters } from "./keyword-ranking/clustering/diagnoseFalseMerges.js";
import { CLUSTERING_CONFIG } from "../config/keywordScoring.js";

function countBy<T>(items: T[], keyFn: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item) ?? "N/A";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function printCounts(counts: Map<string, number>): void {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of sorted) {
    console.log(`   - ${key}: ${count}건`);
  }
}

function printTop10(rankings: RankedKeyword[]): void {
  for (const item of rankings) {
    console.log(
      `\n${item.rank}. [${item.totalScore}점] ${item.keyword} (${item.category}, seed="${item.seedQuery ?? "N/A"}")`
    );
    console.log(`   headline: ${item.headline}`);
  }
}

async function main() {
  const activeSeeds = await SeedQueryRepository.getActiveSeeds();
  console.log(`▶ Daily Keyword Workflow dry-run 시작 (active seed ${activeSeeds.length}개, 실제 NAVER API 사용)`);

  const result = await runDailyKeywordWorkflow({
    collectOptions: { displayPerQuery: 5, requestDelayMs: 200 },
    notifyOptions: { dryRun: true },
  });

  console.log("\n▶ stage log");
  for (const entry of result.stageLog) {
    const detail = entry.error ? ` - ${entry.error}` : "";
    console.log(`   [${entry.stage}] ${entry.status} (${entry.durationMs}ms)${detail}`);
  }

  const failedStage = result.stageLog.find((entry) => entry.status === "failed");
  if (failedStage) {
    console.log(`\n❌ "${failedStage.stage}" 단계에서 실패해 dry-run을 중단합니다.`);
    return;
  }

  console.log("\n▶ A) Active seed 수");
  console.log(`   ${activeSeeds.length}개`);

  console.log("\n▶ B) Candidates (수집 원본, relevance filter 이전)");
  console.log(`   ${result.collected?.candidates.length ?? 0}건`);

  if (result.relevance) {
    console.log("\n▶ C) Relevance filter 전/후");
    console.log(`   필터 전: ${result.relevance.totalBefore}건`);
    console.log(`   필터 후: ${result.relevance.totalAfter}건`);
    console.log(`   제외됨: ${result.relevance.droppedCount}건`);
  }

  console.log("\n▶ D) Clusters (relevance filter 이후 candidate 기준)");
  console.log(`   ${result.clusters?.length ?? 0}개`);

  if (result.clusters) {
    const priorityByQuery = Object.fromEntries(
      activeSeeds.map((seed) => [seed.keyword, seed.priority])
    );
    const diagnostics = result.clusters.map((cluster) => ({
      cluster,
      attribution: resolveClusterAttribution(cluster.items, priorityByQuery),
    }));
    const mixed = diagnostics.filter(
      ({ attribution }) => Object.keys(attribution.candidateCountBySeed).length > 1
    );
    const mismatchCount = diagnostics.filter(({ cluster, attribution }) => {
      if (!attribution.seedQuery) return false;
      return !cluster.items.some(
        (item) =>
          item.metadata.query === attribution.seedQuery &&
          item.keyword === attribution.headline &&
          item.category === attribution.category
      );
    }).length;

    console.log("\n▶ D-1) Cluster attribution 정합성");
    console.log(`   mixed-seed cluster: ${mixed.length}개`);
    console.log(`   seed/category/headline mismatch: ${mismatchCount}개`);
    for (const { cluster, attribution } of mixed.slice(0, 10)) {
      console.log(`\n   cluster keyword: ${cluster.representativeKeyword}`);
      console.log(`   representative headline: ${attribution.headline}`);
      console.log(`   selected seedQuery/category: ${attribution.seedQuery} / ${attribution.category}`);
      console.log(`   candidateCountBySeed: ${JSON.stringify(attribution.candidateCountBySeed)}`);
      console.log(`   averageRelevanceBySeed: ${JSON.stringify(attribution.averageRelevanceBySeed)}`);
      console.log(`   sources: ${attribution.sources.join(", ")}`);
    }

    // false-merge 진단: cluster attribution과 무관하게(=대표 선택 로직을 거치지 않고) cluster 안에
    // 서로 다른 seed가 섞인 경우를 직접 pairwise 유사도로 재검증한다.
    const falseMergeDiagnostics = diagnoseClusters(result.clusters);
    const warningDiagnostics = falseMergeDiagnostics.filter((d) => d.severity === "warning");
    // "token/entity overlap 없이 char n-gram만으로 threshold를 넘긴 것처럼 보이는" pair를
    // false merge 의심 사례로 표시한다 — 실제로는 CLUSTERING_CONFIG의 새 가드 때문에 이런 pair가
    // merge 근거가 될 수 없으므로, 남아있다면 그 merge는 token/entity overlap 등 다른 정당한 이유로
    // 성사됐다는 뜻이다(진단용 참고 지표일 뿐, "여전히 버그"라는 의미는 아니다).
    const suspiciousDiagnostics = falseMergeDiagnostics.filter(
      (d) =>
        d.worstPair &&
        d.worstPair.entityOverlap === 0 &&
        d.worstPair.tokenOverlap < CLUSTERING_CONFIG.minTokenOverlapToTrustCharNgram &&
        d.worstPair.charSimilarity >= 0.5
    );

    console.log("\n▶ D-2) False-merge 진단 (diagnoseClusters)");
    console.log(`   mixed-seed cluster(2개 이상 seed): ${falseMergeDiagnostics.length}개`);
    console.log(`   5개 이상 seed 혼재(⚠️ warning): ${warningDiagnostics.length}개`);
    console.log(
      `   token/entity overlap 없이 char n-gram만 높은(boilerplate 의심) pair: ${suspiciousDiagnostics.length}개`
    );
    for (const diag of falseMergeDiagnostics) {
      const marker = diag.severity === "warning" ? "⚠️ " : "";
      console.log(`\n   ${marker}cluster: "${diag.clusterKeyword}" (size ${diag.clusterSize})`);
      console.log(`   seedQueries: ${diag.seedQueries.join(", ")}`);
      console.log(`   representative titles: ${diag.representativeNormalizedTitles.join(" | ")}`);
      if (diag.worstPair) {
        console.log(
          `   worst pair: "${diag.worstPair.titleA}"(${diag.worstPair.seedA}) <-> ` +
            `"${diag.worstPair.titleB}"(${diag.worstPair.seedB})`
        );
        console.log(
          `   tokenOverlap=${diag.worstPair.tokenOverlap} entityOverlap=${diag.worstPair.entityOverlap} ` +
            `charSimilarity=${diag.worstPair.charSimilarity} combined=${diag.worstPair.combined}`
        );
      }
    }

    // 특정 시나리오 확인: "폭염/넷플릭스/배우"처럼 서로 무관한 seed가 위키백과/나무위키류 boilerplate
    // 때문에 하나의 cluster로 묶이는 사례가 남아있는지 직접 검사한다.
    const knownUnrelatedSeeds = ["폭염", "넷플릭스", "배우"];
    const unrelatedSeedCollision = falseMergeDiagnostics.filter(
      (d) => knownUnrelatedSeeds.filter((seed) => d.seedQueries.includes(seed)).length >= 2
    );
    console.log(
      `\n▶ D-3) "폭염/넷플릭스/배우" 등 무관 seed가 boilerplate로 같은 cluster에 섞인 사례: ${unrelatedSeedCollision.length}건`
    );
  }

  if (result.ranked) {
    console.log("\n▶ E) diversity 적용 전 Top10 (순수 totalScore 기준)");
    printTop10(result.ranked.preDiversityRankings);
    console.log("\n   --- category 분포 ---");
    printCounts(countBy(result.ranked.preDiversityRankings, (item) => item.category));
    console.log("   --- seedQuery 분포 ---");
    printCounts(countBy(result.ranked.preDiversityRankings, (item) => item.seedQuery));

    console.log("\n▶ F) diversity 적용 후 최종 Top10");
    printTop10(result.ranked.rankings);
    console.log("\n   --- category 분포 ---");
    printCounts(countBy(result.ranked.rankings, (item) => item.category));
    console.log("   --- seedQuery 분포 ---");
    const finalSeedCounts = countBy(result.ranked.rankings, (item) => item.seedQuery);
    printCounts(finalSeedCounts);

    const maxSeedCount = Math.max(0, ...[...finalSeedCounts.values()]);
    console.log(`\n▶ G) 최종 Top10 내 동일 seed 최대 등장 횟수: ${maxSeedCount}`);

    const coupangPlayLeakage = result.ranked.rankings.filter(
      (item) =>
        item.seedQuery === "쿠팡플레이" &&
        !item.headline.toLocaleLowerCase().replace(/[^0-9a-z가-힣]+/g, "").includes("쿠팡플레이") &&
        !item.headline.toLocaleLowerCase().replace(/[^0-9a-z가-힣]+/g, "").includes("coupangplay")
    );
    console.log(
      `▶ G-1) 쿠팡플레이 → 일반 쿠팡 콘텐츠 leakage: ${coupangPlayLeakage.length}건`
    );
    for (const item of coupangPlayLeakage) console.log(`   - ${item.headline}`);
  }

  console.log("\n▶ H) Telegram preview (dryRun, 실제 발송 없음)");
  if (result.notification?.messages && result.notification.messages.length > 0) {
    for (const [index, message] of result.notification.messages.entries()) {
      console.log(`\n--- message ${index + 1}/${result.notification.messages.length} ---`);
      console.log(message);
    }
  } else {
    console.log(`   미생성 (reason: ${result.notification?.reason ?? "unknown"})`);
  }

  console.log("\n✅ Daily Keyword Workflow dry-run 완료 (Telegram 미발송)");
}

main().catch((error) => {
  console.error("❌ dry-run 실패:", error.message ?? error);
  process.exit(1);
});
