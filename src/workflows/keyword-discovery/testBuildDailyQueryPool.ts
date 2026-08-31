// buildDailyQueryPool의 seed + 동적 소스 merge와 seed-only fallback 회귀 테스트.
// 조회 함수를 주입하고 enabledSources를 명시하므로 실제 Supabase 조회/insert/migration은 전혀
// 수행하지 않는다 - enabledSources를 생략하면 config 기본값(google_trends=true)을 따라가 실제
// 네트워크를 건드리게 된다.

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
    // enabledSources를 명시해 creator_advisor 외의 소스가 실제 Supabase를 조회하지 않게 한다.
    // 이걸 빼면 google_trends가 기본 enabled라 테스트가 외부 네트워크를 건드린다.
    enabledSources: ["creator_advisor"],
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
    // enabledSources를 명시해 creator_advisor 외의 소스가 실제 Supabase를 조회하지 않게 한다.
    // 이걸 빼면 google_trends가 기본 enabled라 테스트가 외부 네트워크를 건드린다.
    enabledSources: ["creator_advisor"],
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
    // enabledSources를 명시해 creator_advisor 외의 소스가 실제 Supabase를 조회하지 않게 한다.
    // 이걸 빼면 google_trends가 기본 enabled라 테스트가 외부 네트워크를 건드린다.
    enabledSources: ["creator_advisor"],
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
    enabledSources: ["creator_advisor"],
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

// 여러 소스를 동시에 켰을 때: 하나가 죽어도 나머지가 살아야 하고, 실패 원인이 소스별로 남아야 한다.
async function testMultiSourceIsolatesFailures(): Promise<void> {
  const result = await buildDailyQueryPool({
    enabledSources: ["creator_advisor", "google_trends"],
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => [makeSeed()],
    loadLatestCreatorAdvisorCandidates: async () => {
      // Supabase가 던지는 PostgrestError 형태(Error 인스턴스가 아닌 평범한 객체).
      // String(error)로 감싸면 "[object Object]"가 되어 원인이 통째로 사라진다.
      throw { message: "relation does not exist", code: "42P01", details: "trend_candidates" };
    },
    loadCandidatesBySource: {
      google_trends: async () => ({
        trendDate: "2026-08-29",
        candidates: [
          makeTrend({
            id: "gt-1",
            keyword: "유재석",
            keyword_normalized: "유재석",
            topic: "google_trends",
            topic_normalized: "entertainment",
            source: "google_trends",
            trend_date: "2026-08-29",
            rank: 1,
            candidate_score: 45,
          }),
        ],
      }),
    },
  });

  assert(result.entries.length === 2, `seed 1 + google_trends 1 = 2건이어야 합니다 (실제: ${result.entries.length})`);

  const fromGoogle = result.entries.find((entry) => entry.keyword === "유재석");
  assert(fromGoogle, "한 소스가 실패해도 다른 소스 결과는 살아야 합니다");
  assert(fromGoogle.source === "google_trends", `entry.source가 남아야 합니다 (실제: ${fromGoogle.source})`);
  assert(fromGoogle.origin === "trend", `creator_advisor 외 소스의 origin은 trend여야 합니다 (실제: ${fromGoogle.origin})`);
  assert(result.trendCountBySource.google_trends === 1, "소스별 기여 건수가 집계돼야 합니다");

  const caError = result.trendErrorBySource.creator_advisor;
  assert(caError, "실패한 소스의 오류가 소스별로 남아야 합니다");
  assert(
    caError.includes("relation does not exist") && caError.includes("42P01"),
    `PostgrestError가 [object Object]가 되면 안 됩니다 (실제: ${caError})`
  );
  assert(!result.trendErrorBySource.google_trends, "성공한 소스는 오류가 없어야 합니다");

  console.log("✅ 소스 하나가 죽어도 나머지 진행 + 실패 원인 보존:", result.trendErrorBySource);
}

// 오후 커뮤니티 전용 run: includeSeedQueries=false면 seed_queries를 아예 조회하지 않고
// 동적 소스(community)만으로 pool을 만든다.
async function testIncludeSeedQueriesFalseUsesDynamicSourcesOnly(): Promise<void> {
  let seedLookupCalled = false;
  const result = await buildDailyQueryPool({
    includeSeedQueries: false,
    enabledSources: ["community"],
    loadActiveSeeds: async () => {
      seedLookupCalled = true;
      return [makeSeed()];
    },
    loadCandidatesBySource: {
      community: async () => ({
        trendDate: "2026-08-31",
        candidates: [
          makeTrend({
            id: "cm-1",
            keyword: "더쿠 화제글",
            keyword_normalized: "더쿠 화제글",
            topic: "community",
            topic_normalized: "community",
            source: "community",
            trend_date: "2026-08-31",
            rank: 1,
            candidate_score: 20,
          }),
        ],
      }),
    },
  });

  assert(!seedLookupCalled, "includeSeedQueries=false면 seed_queries를 조회하면 안 됩니다");
  assert(result.seedCount === 0, `seedCount는 0이어야 합니다 (실제: ${result.seedCount})`);
  assert(
    result.entries.length === 1 && result.entries[0].source === "community",
    "동적 소스(community) entry만 남아야 합니다"
  );
  console.log("✅ includeSeedQueries=false -> seed 조회 없이 동적 소스만");
}

async function main(): Promise<void> {
  console.log("▶ Daily Query Pool merge/fallback 테스트 시작");
  await testSeedAndCreatorAdvisorMerge();
  await testSeedMergeKeepsHighestCreatorAdvisorSignal();
  await testCreatorAdvisorFailureFallsBackToSeeds();
  await testCreatorAdvisorDisabledUsesSeedsOnly();
  await testMultiSourceIsolatesFailures();
  await testIncludeSeedQueriesFalseUsesDynamicSourcesOnly();
  console.log("\n✅ Daily Query Pool 테스트 완료");
}

await main();
