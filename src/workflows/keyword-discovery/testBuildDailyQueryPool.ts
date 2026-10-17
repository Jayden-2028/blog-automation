// buildDailyQueryPool의 seed + 동적 소스 merge와 seed-only fallback 회귀 테스트.
// 조회 함수를 주입하고 enabledSources를 명시하므로 실제 Supabase 조회/insert/migration은 전혀
// 수행하지 않는다 - enabledSources를 생략하면 config 기본값(google_trends=true)을 따라가 실제
// 네트워크를 건드리게 된다.

import { buildDailyQueryPool, parseVariantFoldEnabled } from "./buildDailyQueryPool.js";
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

// ---------- 변형 키워드 접기 (QUERY-POOL-VARIANT-FOLD-2026-10.md) ----------
//
// 픽스처는 2026-10-17 엔터 run 166 실측이다. CA가 "나솔사계" 변형을 상위로 쏟아내 Top 10에서 4칸을
// 먹었다. topic을 방송·예능·드라마로 흩어 둔 것도 실측대로다 - 한 topic에 10건을 몰면
// selectTopCreatorAdvisorCandidates의 maxCandidatesPerTopic(6)에 먼저 잘려 접기 입력이 달라진다.
const VARIANT_FIXTURE: { keyword: string; rank: number; topic: string }[] = [
  { keyword: "나솔사계 현커", rank: 1, topic: "방송" },
  { keyword: "나솔사계", rank: 2, topic: "예능" },
  { keyword: "나솔사계 라방", rank: 4, topic: "방송" },
  { keyword: "나는 SOLO, 그 후 사랑은 계속된다(나솔사계)", rank: 5, topic: "드라마" },
  { keyword: "나솔사계 최종커플", rank: 6, topic: "예능" },
  { keyword: "나솔사계 커플 현황", rank: 9, topic: "방송" },
  { keyword: "나솔사계 최종커플 근황", rank: 11, topic: "드라마" },
  { keyword: "나솔사계 최종 커플", rank: 13, topic: "예능" },
  { keyword: "나솔사계 옥순 미스터조", rank: 17, topic: "방송" },
  { keyword: "나솔사계 미스터서", rank: 18, topic: "드라마" },
];

function makeVariantTrends(): TrendCandidateRow[] {
  return VARIANT_FIXTURE.map((item, index) =>
    makeTrend({
      id: `variant-${index + 1}`,
      keyword: item.keyword,
      keyword_normalized: item.keyword,
      topic: item.topic,
      topic_normalized: "entertainment",
      trend_date: "2026-10-17",
      rank: item.rank,
      movement_type: "up",
      rank_change: null,
      // 실제 candidate_score는 rank와 반비례한다. 접기의 대표 선정이 rank를 먼저 보는지
      // 확인하려면 둘이 같은 방향이어야 한다(score만으로도 같은 답이 나오면 검증이 안 된다).
      candidate_score: 40 - item.rank,
    })
  );
}

async function buildVariantPool(variantFoldEnabled?: boolean) {
  return buildDailyQueryPool({
    enabledSources: ["creator_advisor"],
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => [],
    includeSeedQueries: false,
    ...(variantFoldEnabled === undefined ? {} : { variantFoldEnabled }),
    loadLatestCreatorAdvisorCandidates: async () => ({
      trendDate: "2026-10-17",
      candidates: makeVariantTrends(),
    }),
  });
}

async function testVariantFoldKeepsBaseAndTopRank(): Promise<void> {
  const result = await buildVariantPool();
  const keywords = result.entries.map((entry) => entry.keyword);

  assert(
    result.foldedGroups.length === 1,
    `접힌 그룹은 1개여야 합니다 (실제: ${result.foldedGroups.length})`
  );
  const [group] = result.foldedGroups;
  assert(group.base === "나솔사계", `base는 토큰이 가장 적은 "나솔사계"여야 합니다 (실제: ${group.base})`);
  assert(
    group.kept.length === 2 && group.kept[0] === "나솔사계" && group.kept[1] === "나솔사계 현커",
    `대표는 [나솔사계, 나솔사계 현커(rank1)]여야 합니다 (실제: ${group.kept.join(", ")})`
  );
  assert(group.dropped.length === 7, `접힘은 7건이어야 합니다 (실제: ${group.dropped.length})`);
  assert(
    group.dropped[0] === "나솔사계 라방",
    `접힘 목록은 rank 순이어야 합니다 (실제 첫 항목: ${group.dropped[0]})`
  );

  assert(keywords.length === 3, `pool은 3건이어야 합니다 (실제: ${keywords.length} - ${keywords.join(", ")})`);
  assert(keywords.includes("나솔사계") && keywords.includes("나솔사계 현커"), "대표 2건이 pool에 남아야 합니다");
  assert(
    keywords.includes("나는 SOLO, 그 후 사랑은 계속된다(나솔사계)"),
    "표기 변형(첫 토큰이 다름)은 접히지 않고 독립 생존해야 합니다 - 알려진 한계다"
  );
  assert(result.trendCount === 3, `trendCount는 접은 뒤 값이어야 합니다 (실제: ${result.trendCount})`);

  console.log("✅ 변형 접기: 나솔사계 9건 -> 대표 2건, 표기 변형 1건 독립 생존");
}

async function testVariantFoldSkipsSeedAndMergedEntries(): Promise<void> {
  // base "나솔사계"가 seed에 있으면 CA의 같은 키워드는 origin="merged"가 된다. merged는 접기
  // 후보에서 빠지므로 **anchor로도 쓰이지 않고**, 형제 변형끼리는 서로 부분집합이 아니라 안 묶인다.
  const seeds = [makeSeed({ id: "seed-nsg", keyword: "나솔사계", category: "entertainment", priority: 7 })];
  const trends = makeVariantTrends().filter((row) =>
    ["나솔사계", "나솔사계 현커", "나솔사계 라방", "나솔사계 최종커플"].includes(row.keyword)
  );

  const result = await buildDailyQueryPool({
    enabledSources: ["creator_advisor"],
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => seeds,
    loadLatestCreatorAdvisorCandidates: async () => ({ trendDate: "2026-10-17", candidates: trends }),
  });

  const merged = result.entries.find((entry) => entry.keyword === "나솔사계");
  assert(merged?.origin === "merged", `seed와 겹친 키워드는 merged여야 합니다 (실제: ${merged?.origin})`);
  assert(result.foldedGroups.length === 0, "seed·merged는 접기 대상도 anchor도 아니므로 접힘이 없어야 합니다");
  assert(
    result.entries.length === 4,
    `merged 1 + 변형 3이 그대로 남아야 합니다 (실제: ${result.entries.length})`
  );

  console.log("✅ seed·merged는 안 접힘 + base 부재 시 형제 변형끼리 안 묶임");
}

async function testVariantFoldDoesNotMixDifferentSubjects(): Promise<void> {
  const trends = [
    makeTrend({ id: "kjw-1", keyword: "김지원", keyword_normalized: "김지원", topic: "연예인", rank: 3, candidate_score: 30 }),
    makeTrend({ id: "kjw-2", keyword: "김지원 닥터X", keyword_normalized: "김지원 닥터X", topic: "드라마", rank: 1, candidate_score: 35 }),
    makeTrend({ id: "kjw-3", keyword: "김지원 애프터썬", keyword_normalized: "김지원 애프터썬", topic: "연예인", rank: 5, candidate_score: 25 }),
    makeTrend({ id: "ksh-1", keyword: "김수현", keyword_normalized: "김수현", topic: "연예인", rank: 2, candidate_score: 32 }),
    makeTrend({ id: "ksh-2", keyword: "김수현 사생활", keyword_normalized: "김수현 사생활", topic: "방송", rank: 7, candidate_score: 20 }),
  ];

  const result = await buildDailyQueryPool({
    enabledSources: ["creator_advisor"],
    creatorAdvisorEnabled: true,
    includeSeedQueries: false,
    loadActiveSeeds: async () => [],
    loadLatestCreatorAdvisorCandidates: async () => ({ trendDate: "2026-10-17", candidates: trends }),
  });

  const keywords = result.entries.map((entry) => entry.keyword);
  assert(result.foldedGroups.length === 1, `접힌 그룹은 김지원 하나여야 합니다 (실제: ${result.foldedGroups.length})`);
  assert(result.foldedGroups[0].base === "김지원", `base는 김지원이어야 합니다 (실제: ${result.foldedGroups[0].base})`);
  assert(
    result.foldedGroups[0].kept.join(" / ") === "김지원 / 김지원 닥터X",
    `대표는 [김지원, 김지원 닥터X(rank1)]여야 합니다 (실제: ${result.foldedGroups[0].kept.join(" / ")})`
  );
  assert(
    result.foldedGroups[0].dropped.join(" / ") === "김지원 애프터썬",
    `접힘은 김지원 애프터썬뿐이어야 합니다 (실제: ${result.foldedGroups[0].dropped.join(" / ")})`
  );
  assert(
    keywords.includes("김수현") && keywords.includes("김수현 사생활"),
    "다른 인물(김수현)은 2건 이하라 그대로 남아야 합니다 - 오접힘 없음"
  );
  assert(keywords.length === 4, `pool은 4건이어야 합니다 (실제: ${keywords.length} - ${keywords.join(", ")})`);

  console.log("✅ 다른 인물끼리 오접힘 없음 (김지원 3->2, 김수현 2 유지)");
}

async function testVariantFoldSwitchOff(): Promise<void> {
  assert(parseVariantFoldEnabled(undefined) === true, "미설정은 켜짐이어야 합니다");
  assert(parseVariantFoldEnabled("") === true, "빈 값은 켜짐이어야 합니다(워크플로가 빈 vars를 넘길 수 있다)");
  assert(parseVariantFoldEnabled("  ") === true, "공백만 있는 값도 켜짐이어야 합니다");
  assert(parseVariantFoldEnabled("false") === false, '"false"면 접기를 생략해야 합니다');
  assert(parseVariantFoldEnabled("FALSE") === false, "대문자도 꺼짐이어야 합니다");
  assert(parseVariantFoldEnabled("0") === false, '"0"도 꺼짐이어야 합니다(pipelineGate와 같은 해석)');
  assert(parseVariantFoldEnabled("true") === true, '"true"는 켜짐이어야 합니다');

  const result = await buildVariantPool(false);
  assert(result.foldedGroups.length === 0, "스위치가 꺼지면 foldedGroups는 비어야 합니다");
  assert(
    result.entries.length === VARIANT_FIXTURE.length,
    `스위치가 꺼지면 ${VARIANT_FIXTURE.length}건 전부 남아야 합니다 (실제: ${result.entries.length})`
  );

  console.log("✅ QUERY_POOL_VARIANT_FOLD=false -> 무변경(롤백 경로)");
}

async function main(): Promise<void> {
  console.log("▶ Daily Query Pool merge/fallback 테스트 시작");
  await testSeedAndCreatorAdvisorMerge();
  await testSeedMergeKeepsHighestCreatorAdvisorSignal();
  await testCreatorAdvisorFailureFallsBackToSeeds();
  await testCreatorAdvisorDisabledUsesSeedsOnly();
  await testMultiSourceIsolatesFailures();
  await testIncludeSeedQueriesFalseUsesDynamicSourcesOnly();
  await testVariantFoldKeepsBaseAndTopRank();
  await testVariantFoldSkipsSeedAndMergedEntries();
  await testVariantFoldDoesNotMixDifferentSubjects();
  await testVariantFoldSwitchOff();
  console.log("\n✅ Daily Query Pool 테스트 완료");
}

await main();
