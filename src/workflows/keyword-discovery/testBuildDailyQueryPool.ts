// buildDailyQueryPool의 seed + Creator Advisor merge와 seed-only fallback 회귀 테스트.
// 조회 함수를 주입하므로 실제 Supabase 조회/insert/migration은 전혀 수행하지 않는다.

import { buildDailyQueryPool } from "./buildDailyQueryPool.js";
import type { SeedQueryRow, TrendCandidateRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeSeed(overrides: Partial<SeedQueryRow> = {}): SeedQueryRow {
  return {
    id: "seed-1",
    keyword: "폭싹 속았수다",
    category: "ott",
    priority: 9,
    status: "active",
    source: "manual",
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function makeTrend(overrides: Partial<TrendCandidateRow> = {}): TrendCandidateRow {
  return {
    id: "trend-1",
    keyword: "폭싹 속았수다",
    keyword_normalized: "폭싹 속았수다",
    topic: "드라마",
    topic_normalized: "ott",
    source: "creator_advisor",
    trend_date: "2026-08-24",
    rank: 2,
    movement_type: "up",
    rank_change: 18,
    candidate_score: 32,
    collected_at: "2026-08-25T16:00:00.000Z",
    expires_at: "2026-08-26T16:00:00.000Z",
    status: "active",
    metadata: {},
    created_at: "2026-08-25T16:00:00.000Z",
    updated_at: "2026-08-25T16:00:00.000Z",
    ...overrides,
  };
}

async function testSeedAndCreatorAdvisorMerge(): Promise<void> {
  const seeds = [makeSeed()];
  const trends = [
    makeTrend(),
    makeTrend({
      id: "trend-2",
      keyword: "신병4 사보타주",
      keyword_normalized: "신병4 사보타주",
      rank: 4,
      movement_type: "new",
      rank_change: null,
      candidate_score: 30,
    }),
    makeTrend({
      id: "trend-3",
      keyword: "신병4 사보타주",
      keyword_normalized: "신병4 사보타주",
      topic: "영화",
      rank: 8,
      movement_type: "flat",
      rank_change: 0,
      candidate_score: 15,
    }),
  ];

  const result = await buildDailyQueryPool({
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => seeds,
    loadLatestCreatorAdvisorCandidates: async () => ({
      trendDate: "2026-08-24",
      candidates: trends,
    }),
  });

  assert(result.entries.length === 2, `seed 1 + CA 3(seed 중복 1, CA 중복 1) 결과는 2개여야 합니다 (실제: ${result.entries.length})`);
  assert(result.seedCount === 1, `seedCount는 1이어야 합니다 (실제: ${result.seedCount})`);
  assert(result.trendCount === 1, `CA 전용 entry는 1개여야 합니다 (실제: ${result.trendCount})`);
  assert(result.trendMergedCount === 1, `seed에 병합된 CA는 1개여야 합니다 (실제: ${result.trendMergedCount})`);

  const merged = result.entries.find((entry) => entry.keyword === "폭싹 속았수다");
  assert(merged, "중복 keyword가 결과에 남아야 합니다");
  assert(merged.origin === "merged", `중복 keyword origin은 merged여야 합니다 (실제: ${merged.origin})`);
  assert(merged.category === "ott", "병합 시 seed의 category를 primary로 유지해야 합니다");
  assert(merged.priority === 9, "병합 시 seed의 priority를 primary로 유지해야 합니다");

  const signal = merged.metadata.creatorAdvisor as Record<string, unknown> | undefined;
  assert(signal, "병합된 entry metadata에 creatorAdvisor 신호가 있어야 합니다");
  assert(signal.topic === "드라마", "metadata에 원본 topic이 남아야 합니다");
  assert(signal.trendDate === "2026-08-24", "metadata에 trendDate가 남아야 합니다");
  assert(signal.rank === 2, "metadata에 rank가 남아야 합니다");
  assert(signal.movementType === "up", "metadata에 movementType이 남아야 합니다");
  assert(signal.rankChange === 18, "metadata에 rankChange가 남아야 합니다");
  assert(signal.candidateScore === 32, "metadata에 candidateScore가 남아야 합니다");

  const creatorAdvisorOnly = result.entries.find((entry) => entry.keyword === "신병4 사보타주");
  assert(creatorAdvisorOnly?.origin === "creator_advisor", "CA끼리 중복된 keyword는 merged가 아니라 creator_advisor여야 합니다");
  assert(creatorAdvisorOnly.metadata.candidateScore === 30, "CA끼리 중복되면 candidateScore가 높은 entry를 유지해야 합니다");

  console.log("✅ seed + Creator Advisor 중복 merge:", merged);
}

async function testCreatorAdvisorFailureFallsBackToSeeds(): Promise<void> {
  const seeds = [makeSeed(), makeSeed({ id: "seed-2", keyword: "육아 지원금", category: "parenting" })];

  const result = await buildDailyQueryPool({
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => seeds,
    loadLatestCreatorAdvisorCandidates: async () => {
      throw new Error("forced Creator Advisor lookup failure");
    },
  });

  assert(result.entries.length === 2, `CA 장애 시 seed 2개가 그대로 반환되어야 합니다 (실제: ${result.entries.length})`);
  assert(result.entries.every((entry) => entry.origin === "seed"), "CA 장애 시 모든 결과 origin은 seed여야 합니다");
  assert(result.seedCount === 2, `seedCount는 2여야 합니다 (실제: ${result.seedCount})`);
  assert(result.trendCount === 0, `trendCount는 0이어야 합니다 (실제: ${result.trendCount})`);
  assert(result.trendMergedCount === 0, `trendMergedCount는 0이어야 합니다 (실제: ${result.trendMergedCount})`);
  assert(result.trendError === "forced Creator Advisor lookup failure", "장애 원인이 trendError에 남아야 합니다");

  console.log("✅ Creator Advisor 조회 실패 -> seed-only fallback:", {
    seedCount: result.seedCount,
    trendCount: result.trendCount,
    entries: result.entries.map((entry) => entry.keyword),
    trendError: result.trendError,
  });
}

async function testSeedMergeKeepsHighestCreatorAdvisorSignal(): Promise<void> {
  const result = await buildDailyQueryPool({
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => [makeSeed()],
    loadLatestCreatorAdvisorCandidates: async () => ({
      trendDate: "2026-08-24",
      candidates: [
        makeTrend({ id: "trend-high", candidate_score: 32, topic: "드라마", rank: 2 }),
        makeTrend({ id: "trend-low", candidate_score: 10, topic: "방송", rank: 9 }),
      ],
    }),
  });

  assert(result.entries.length === 1, "같은 seed keyword와 겹친 CA 후보들은 query 1개로 병합되어야 합니다");
  assert(result.trendMergedCount === 2, "seed와 겹친 CA 후보 2개가 모두 merge count에 반영되어야 합니다");

  const signal = result.entries[0]!.metadata.creatorAdvisor as Record<string, unknown>;
  assert(signal.candidateScore === 32, "여러 CA 신호 중 candidateScore가 가장 높은 신호를 보존해야 합니다");
  assert(signal.topic === "드라마" && signal.rank === 2, "최고 점수 CA 신호의 metadata가 함께 보존되어야 합니다");
  console.log("✅ seed + 복수 Creator Advisor 중복 merge -> 최고 pre-score 신호 보존");
}

async function testCreatorAdvisorDisabledUsesSeedsOnly(): Promise<void> {
  let trendLookupCalled = false;
  const result = await buildDailyQueryPool({
    creatorAdvisorEnabled: false,
    loadActiveSeeds: async () => [makeSeed()],
    loadLatestCreatorAdvisorCandidates: async () => {
      trendLookupCalled = true;
      return { trendDate: null, candidates: [] };
    },
  });

  assert(!trendLookupCalled, "Creator Advisor disabled이면 trend_candidates를 조회하면 안 됩니다");
  assert(result.entries.length === 1 && result.entries[0].origin === "seed", "disabled이면 seed-only 결과여야 합니다");
  assert(result.trendCount === 0 && result.trendMergedCount === 0, "disabled이면 trend count는 모두 0이어야 합니다");
  console.log("✅ Creator Advisor disabled -> 조회 없이 seed-only");
}

async function main(): Promise<void> {
  console.log("▶ Daily Query Pool merge/fallback 테스트 시작");
  await testSeedAndCreatorAdvisorMerge();
  await testSeedMergeKeepsHighestCreatorAdvisorSignal();
  await testCreatorAdvisorFailureFallsBackToSeeds();
  await testCreatorAdvisorDisabledUsesSeedsOnly();
  console.log("\n✅ Daily Query Pool 테스트 완료");
}

await main();
