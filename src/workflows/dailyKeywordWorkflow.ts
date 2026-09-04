// 하루 1회 실행되는 keyword 파이프라인 전체(seed 조회 -> 수집 -> 클러스터링 -> 랭킹 -> 저장 -> Telegram 알림).
// seed 검색어는 options.queries를 생략하면 SeedQueryRepository.getActiveSeeds()(seed_queries 테이블)로
// 조회한다 — 더 이상 코드 내부 배열(naverCategoryMap.ts의 DEFAULT_CATEGORY_BY_QUERY)에 의존하지 않는다.
//
// runKeywordRanking.ts(keyword-ranking/)와 달리, 여기서는 각 단계를 독립적으로 호출 가능한 함수로
// 분리해서 노출한다: collectCandidates() / clusterKeywords() / rankKeywords() / saveRankingHistory() /
// sendTelegramNotification(). 지금 당장은 runDailyKeywordWorkflow()가 이 단계들을 순서대로 이어붙이지만,
// 나중에 n8n 같은 외부 오케스트레이터가 각 단계를 개별 노드로 호출하고 싶을 때 이 파일에서 필요한
// 함수만 import해서 쓸 수 있도록 하기 위함이다. (runKeywordRanking.ts의 scoring 로직 일부와 겹치는데,
// 이미 검증된 그 파이프라인은 건드리지 않고 이 파일에서 별도로 조합했다.)
//
// 실패 처리: 각 단계는 실패해도 예외를 밖으로 던지지 않고 stageLog에 { stage, status: "failed", error }로
// 기록한 뒤 이후 단계를 "skipped" 처리하고 즉시 반환한다 — 그래서 호출자는 stageLog만 보면 정확히
// 어느 단계에서 왜 멈췄는지 알 수 있다(예: NAVER API 실패 vs Supabase 저장 실패 vs Telegram 발송 실패).

import type { TrendSource } from "../config/trendSources.js";
import { runCommunityCollection } from "./community/runCommunityCollection.js";
import { runCreatorAdvisorCollection } from "./creator-advisor/runCreatorAdvisorCollection.js";
import { runGoogleTrendsCollection } from "./google-trends/runGoogleTrendsCollection.js";
import { buildDailyQueryPool } from "./keyword-discovery/buildDailyQueryPool.js";
import { collectNaverCandidates } from "./keyword-discovery/collectNaverCandidates.js";
import { filterCandidatesByRelevance } from "./keyword-discovery/seedRelevance.js";
import { aggregateClusterSignals } from "./keyword-ranking/aggregateClusterSignals.js";
import { buildReason } from "./keyword-ranking/buildReason.js";
import { CompositeSimilarityClusterer } from "./keyword-ranking/clustering/CompositeSimilarityClusterer.js";
import type { KeywordCluster, KeywordClusterer } from "./keyword-ranking/clustering/KeywordClusterer.js";
import { computeBatchPercentiles } from "./keyword-ranking/computeBatchPercentiles.js";
import { fetchTrendMomentumByQuery } from "./keyword-ranking/fetchTrendMomentum.js";
import { BLOG_COMPETITION_CONFIG, TOPIC_MERGE_CONFIG } from "../config/keywordCompetition.js";
import { buildCompetitionQuery } from "./keyword-ranking/buildCompetitionQuery.js";
import { computeSaturation, describeSaturation } from "./keyword-ranking/computeCompetitionScore.js";
import { mergeSameTopicClusters } from "./keyword-ranking/mergeSameTopicClusters.js";
import { probeBlogCompetition } from "./keyword-ranking/probeBlogCompetition.js";
import { saveRankingHistory as saveRankingHistoryStage } from "./keyword-ranking/saveRankingHistory.js";
import { scoreKeyword } from "./keyword-ranking/scoreKeyword.js";
import { selectDiverseTopN } from "./keyword-ranking/selectDiverseTopN.js";
import { sendKeywordNotification } from "./keyword-notification/sendKeywordNotification.js";
import type {
  RunCreatorAdvisorCollectionOptions,
  RunCreatorAdvisorCollectionResult,
} from "./creator-advisor/runCreatorAdvisorCollection.js";
import type {
  RunGoogleTrendsCollectionOptions,
  RunGoogleTrendsCollectionResult,
} from "./google-trends/runGoogleTrendsCollection.js";
import type {
  RunCommunityCollectionOptions,
  RunCommunityCollectionResult,
} from "./community/runCommunityCollection.js";
import type { BuildDailyQueryPoolResult } from "./keyword-discovery/buildDailyQueryPool.js";
import type {
  CollectNaverCandidatesOptions,
  CollectNaverCandidatesResult,
} from "./keyword-discovery/collectNaverCandidates.js";
import type { FilterCandidatesByRelevanceResult } from "./keyword-discovery/seedRelevance.js";
import type { MergeSameTopicClustersResult } from "./keyword-ranking/mergeSameTopicClusters.js";
import type { ProbeBlogCompetitionResult } from "./keyword-ranking/probeBlogCompetition.js";
import type { KeywordCandidate } from "../types/keywordDiscovery.js";
import type { RankedKeyword } from "../types/keywordScoring.js";
import type {
  SendKeywordNotificationOptions,
  SendKeywordNotificationResult,
} from "../types/keywordNotification.js";
import type { SaveRankingHistoryResult } from "./keyword-ranking/saveRankingHistory.js";

// ---------- 1) collectCandidates ----------

export type CollectCandidatesOptions = CollectNaverCandidatesOptions;

export async function collectCandidates(
  queries: string[],
  options: CollectCandidatesOptions = {}
): Promise<CollectNaverCandidatesResult> {
  return collectNaverCandidates(queries, options);
}

// ---------- 1.5) filterRelevantCandidates ----------
// seed query와 관련성이 낮은 candidate를 clustering 전에 걸러낸다 (Daily Ranking Quality Gate).
// seedRelevance.ts 참고. threshold는 config/keywordScoring.ts의 SEED_RELEVANCE_CONFIG에서 조절한다.

export function filterRelevantCandidates(
  candidates: KeywordCandidate[]
): FilterCandidatesByRelevanceResult {
  return filterCandidatesByRelevance(candidates);
}

// ---------- 2) clusterKeywords ----------

export function clusterKeywords(
  candidates: KeywordCandidate[],
  clusterer: KeywordClusterer = new CompositeSimilarityClusterer()
): KeywordCluster<KeywordCandidate>[] {
  return clusterer.cluster(candidates);
}

// ---------- 3) rankKeywords ----------

export type RankKeywordsOptions = {
  /** 검색어트렌드 momentum 비교를 위한 조회 기간(일). 기본 14일. */
  trendRangeDays?: number;
  /** 반환할 상위 키워드 개수. 기본 10. */
  topN?: number;
  /** 대표 seedQuery 동률 판정에만 사용하는 query별 운영 priority. */
  priorityByQuery?: Record<string, number>;
  /**
   * Top N 주제 중복 판정에서 "분류어"로 취급할 단어(seed_queries 유래 상시 검색어).
   * selectDiverseTopN -> topicGrouping의 extraCategoryTerms로 전달된다.
   */
  categoryTerms?: readonly string[];
};

export type RankKeywordsResult = {
  /** diversity 정책(selectDiverseTopN)까지 적용한 최종 Top N. */
  rankings: RankedKeyword[];
  /** diversity 정책을 적용하기 전, 순수 totalScore 내림차순 Top N (비교/디버그용). */
  preDiversityRankings: RankedKeyword[];
  scoreRange: { min: number; max: number } | null;
  mergedClusterCount: number;
  /** trend momentum 조회 단계에서 발생한 오류(있으면). saveRankingHistory의 error_count 집계에 쓰인다. */
  trendError?: string;
};

export async function rankKeywords(
  clusters: KeywordCluster<KeywordCandidate>[],
  queries: string[],
  options: RankKeywordsOptions = {}
): Promise<RankKeywordsResult> {
  const topN = options.topN ?? 10;

  const { momentumByQuery, error: trendError } = await fetchTrendMomentumByQuery(queries, {
    rangeDays: options.trendRangeDays,
  });

  const rawInputs = clusters.map((cluster) =>
    aggregateClusterSignals(cluster, momentumByQuery, options.priorityByQuery)
  );
  const inputsWithPercentiles = computeBatchPercentiles(rawInputs);

  const scored = inputsWithPercentiles.map((input) => {
    const scoreBreakdown = scoreKeyword(input);
    return {
      totalScore: scoreBreakdown.total,
      ranked: {
        keyword: input.keyword,
        headline: input.headline,
        seedQuery: input.seedQuery,
        category: input.category,
        totalScore: scoreBreakdown.total,
        scoreBreakdown,
        trendDirection: input.trendDirection,
        relatedCount: input.relatedCount,
        sources: input.sources,
        latestPublishedAt: input.latestPublishedAt,
        reason: buildReason(input, scoreBreakdown),
      } satisfies Omit<RankedKeyword, "rank">,
    };
  });

  const scoreRange =
    scored.length > 0
      ? scored.reduce(
          (range, item) => ({
            min: Math.min(range.min, item.totalScore),
            max: Math.max(range.max, item.totalScore),
          }),
          { min: scored[0].totalScore, max: scored[0].totalScore }
        )
      : null;

  const scoredSortedDesc = scored.slice().sort((a, b) => b.totalScore - a.totalScore);

  const preDiversityRankings: RankedKeyword[] = scoredSortedDesc
    .slice(0, topN)
    .map((item, index) => ({ rank: index + 1, ...item.ranked }));

  // diversity 정책(동일 seedQuery/canonical topic 편중 방지 + category backfill)을 적용해 최종 Top N을 뽑는다.
  const diverseSelection = selectDiverseTopN(
    scoredSortedDesc.map((item) => item.ranked),
    topN,
    { categoryTerms: options.categoryTerms }
  );
  const rankings: RankedKeyword[] = diverseSelection.map((item, index) => ({ rank: index + 1, ...item }));

  const mergedClusterCount = clusters.filter((cluster) => cluster.items.length > 1).length;

  return { rankings, preDiversityRankings, scoreRange, mergedClusterCount, trendError };
}

// ---------- 4) saveRankingHistory ----------
// keyword-ranking/saveRankingHistory.ts를 그대로 재노출한다 — 이미 독립적으로 호출 가능한 순수 함수라
// 새로 감쌀 이유가 없다.

export { saveRankingHistoryStage as saveRankingHistory };

// ---------- 5) sendTelegramNotification ----------

export async function sendTelegramNotification(
  runId: number,
  options: Omit<SendKeywordNotificationOptions, "runId"> = {}
): Promise<SendKeywordNotificationResult> {
  return sendKeywordNotification({ ...options, runId });
}

// ---------- 전체 orchestration ----------

export type DailyKeywordStageName =
  | "trendCollect"
  | "seed"
  | "collect"
  | "relevance"
  | "cluster"
  | "rank"
  | "competition"
  | "save"
  | "notify";

export type DailyKeywordStageLogEntry = {
  stage: DailyKeywordStageName;
  status: "success" | "failed" | "skipped";
  durationMs: number;
  error?: string;
};

export type DailyKeywordWorkflowOptions = {
  /** 대상 seed 검색어. 생략하면 SeedQueryRepository.getActiveSeeds()로 조회한 active seed 전체를 쓴다. */
  queries?: string[];
  /** Creator Advisor 수집 단계(trendCollect)에 그대로 전달된다. */
  trendCollectOptions?: RunCreatorAdvisorCollectionOptions;
  /** 구글 트렌드 수집 단계(trendCollect)에 그대로 전달된다. */
  googleTrendsOptions?: RunGoogleTrendsCollectionOptions;
  /** 커뮤니티(더쿠 등) 수집 단계(trendCollect)에 그대로 전달된다. */
  communityOptions?: RunCommunityCollectionOptions;
  /**
   * 이번 run에서 수집·조회할 동적 트렌드 소스. 생략하면 세 소스 모두(현행 동작).
   * - 오전 job: ["creator_advisor", "google_trends"] — 커뮤니티는 오후로 분리(2026-08-31)
   * - 오후 커뮤니티 job: ["community"]
   * trendCollect 단계에서 어떤 수집기를 돌릴지, buildDailyQueryPool이 어떤 source의 trend_candidates를
   * 읽을지를 함께 결정한다(오후 run이 오전에 쌓인 creator_advisor 후보를 다시 태우지 않도록).
   */
  collectionSources?: readonly TrendSource[];
  /** buildDailyQueryPool에 그대로 전달. false면 seed_queries를 빼고 동적 소스만으로 pool을 만든다(오후 커뮤니티 전용). */
  includeSeedQueries?: boolean;
  collectOptions?: CollectCandidatesOptions;
  clusterer?: KeywordClusterer;
  rankOptions?: RankKeywordsOptions;
  /** saveRankingHistory에 남길 추가 메타데이터. */
  metadata?: Record<string, unknown>;
  notifyOptions?: Omit<SendKeywordNotificationOptions, "runId">;
};

export type DailyKeywordWorkflowResult = {
  stageLog: DailyKeywordStageLogEntry[];
  /** Creator Advisor 수집 결과. options.queries를 명시적으로 넘긴 경우 null(수집 단계를 건너뜀). */
  trendCollection: RunCreatorAdvisorCollectionResult | null;
  /** 구글 트렌드 수집 결과. 위와 같다. disabled면 status="skipped". */
  googleTrendsCollection: RunGoogleTrendsCollectionResult | null;
  /** 커뮤니티 수집 결과. 위와 같다. disabled면 status="skipped". */
  communityCollection: RunCommunityCollectionResult | null;
  /** options.queries를 명시적으로 넘긴 경우 null - buildDailyQueryPool()을 거치지 않았으므로. */
  queryPool: BuildDailyQueryPoolResult | null;
  collected: CollectNaverCandidatesResult | null;
  relevance: FilterCandidatesByRelevanceResult | null;
  clusters: KeywordCluster<KeywordCandidate>[] | null;
  /**
   * 같은 주제 cluster 2차 병합 결과. preview가 꺼져 있으면 null.
   * 기본 설정에서는 계산만 하고 clusters에는 반영하지 않는다(TOPIC_MERGE_CONFIG.applyToClusters).
   */
  topicMerge: MergeSameTopicClustersResult<KeywordCandidate> | null;
  ranked: RankKeywordsResult | null;
  /**
   * 최종 Top N의 블로그 경쟁도(문서 총 개수) 관측 결과. disabled면 null.
   * Phase A에서는 점수에 반영하지 않고 metadata 기록/로그로만 남긴다(config/keywordCompetition.ts).
   */
  competition: ProbeBlogCompetitionResult | null;
  saved: SaveRankingHistoryResult | null;
  notification: SendKeywordNotificationResult | null;
};

async function runStage<T>(
  stageLog: DailyKeywordStageLogEntry[],
  stage: DailyKeywordStageName,
  fn: () => Promise<T>
): Promise<T | null> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    stageLog.push({ stage, status: "success", durationMs: Date.now() - startedAt });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ [dailyKeywordWorkflow] "${stage}" 단계 실패 -`, message);
    stageLog.push({ stage, status: "failed", durationMs: Date.now() - startedAt, error: message });
    return null;
  }
}

function skipRemaining(stageLog: DailyKeywordStageLogEntry[], stages: DailyKeywordStageName[]): void {
  for (const stage of stages) {
    stageLog.push({ stage, status: "skipped", durationMs: 0 });
  }
}

export async function runDailyKeywordWorkflow(
  options: DailyKeywordWorkflowOptions = {}
): Promise<DailyKeywordWorkflowResult> {
  const startedAt = new Date();
  const stageLog: DailyKeywordStageLogEntry[] = [];

  const result: DailyKeywordWorkflowResult = {
    stageLog,
    trendCollection: null,
    googleTrendsCollection: null,
    communityCollection: null,
    queryPool: null,
    collected: null,
    relevance: null,
    clusters: null,
    topicMerge: null,
    ranked: null,
    competition: null,
    saved: null,
    notification: null,
  };

  let queries = options.queries;
  let seedCategoryByQuery: Record<string, string> | undefined;
  let seedPriorityByQuery: Record<string, number> | undefined;
  // seed_queries(사람이 등록한 상시 검색어)만 모은다. Creator Advisor에서 온 그날의 화제 키워드는
  // 주제 그 자체이므로 분류어로 취급하면 안 된다(topicGrouping.ts 참고).
  let stableSeedTerms: string[] | undefined;

  if (!queries) {
    // Creator Advisor를 먼저 수집해 trend_candidates를 최신화한 뒤 query pool을 조립한다.
    // 순서가 중요하다: buildDailyQueryPool()은 trend_candidates를 "읽기"만 하므로, 이 수집이
    // 먼저 돌지 않으면 어제 이전 데이터(또는 아무것도 없는 상태)로 pool이 만들어진다.
    //
    // 이 단계는 실패해도 파이프라인을 멈추지 않는다(runStage의 조기 반환을 쓰지 않는 이유).
    // Creator Advisor는 seed_queries를 보강하는 enrichment source일 뿐 필수 의존성이 아니며,
    // runCreatorAdvisorCollection() 자체가 예외를 던지지 않고 status로 실패를 알린다.
    const trendStartedAt = Date.now();

    // 이번 run이 다룰 동적 소스. 생략하면 세 소스 모두(현행). 오전 job은 커뮤니티를 빼고,
    // 오후 커뮤니티 job은 community 하나만 넘긴다(2026-08-31, 발송 2회 분리).
    const collectionSources: readonly TrendSource[] =
      options.collectionSources ?? ["creator_advisor", "google_trends", "community"];
    const forceSkip = { enabled: false } as const;

    // 소스별로 독립 수집한다. 하나가 실패해도 나머지는 계속 돌아야 하므로 순차 실행하되 서로의
    // 결과를 참조하지 않는다. 각 러너는 throw하지 않고 status로만 알린다(각 파일 상단 주석).
    // collectionSources에 없는 소스는 enabled:false로 강제 skip한다.
    const trendCollection = await runCreatorAdvisorCollection(
      collectionSources.includes("creator_advisor") ? options.trendCollectOptions : { ...options.trendCollectOptions, ...forceSkip }
    );
    result.trendCollection = trendCollection;

    const googleTrendsCollection = await runGoogleTrendsCollection(
      collectionSources.includes("google_trends") ? options.googleTrendsOptions : { ...options.googleTrendsOptions, ...forceSkip }
    );
    result.googleTrendsCollection = googleTrendsCollection;

    const communityCollection = await runCommunityCollection(
      collectionSources.includes("community") ? options.communityOptions : { ...options.communityOptions, ...forceSkip }
    );
    result.communityCollection = communityCollection;

    if (trendCollection.status === "success") {
      console.log(
        `ℹ️ [dailyKeywordWorkflow] Creator Advisor 수집: ${trendCollection.fetchedCount}건 조회 → ` +
          `${trendCollection.upsertedCount}건 저장 (trendDate: ${trendCollection.trendDate ?? "N/A"}, 만료 ${trendCollection.expiredCount}건)`
      );
    }
    if (googleTrendsCollection.status === "success") {
      console.log(
        `ℹ️ [dailyKeywordWorkflow] 구글 트렌드 수집: ${googleTrendsCollection.fetchedCount}건 조회 → ` +
          `${googleTrendsCollection.upsertedCount}건 저장 (trendDate: ${googleTrendsCollection.trendDate ?? "N/A"}, 만료 ${googleTrendsCollection.expiredCount}건)`
      );
    }
    if (communityCollection.status === "success") {
      console.log(
        `ℹ️ [dailyKeywordWorkflow] 커뮤니티 수집: ${communityCollection.fetchedCount}건 조회 → ` +
          `${communityCollection.upsertedCount}건 저장 (trendDate: ${communityCollection.trendDate ?? "N/A"}, 만료 ${communityCollection.expiredCount}건)`
      );
    }

    // stage 하나에 여러 소스가 들어가므로 상태를 집계한다.
    // - 하나라도 성공 -> success (나머지 실패는 error 문자열로만 남긴다)
    // - 전부 skipped   -> skipped (소스가 전부 disabled인 정상 상태)
    // - 그 외(성공 0 + 실패 1 이상) -> failed
    // 어느 쪽이든 이 단계는 파이프라인을 멈추지 않는다 - 동적 소스는 전부 enrichment다.
    const trendResults = [
      { source: "creator_advisor", result: trendCollection },
      { source: "google_trends", result: googleTrendsCollection },
      { source: "community", result: communityCollection },
    ];
    const succeeded = trendResults.filter((entry) => entry.result.status === "success");
    const failures = trendResults.filter((entry) => entry.result.status === "failed");
    const trendStageStatus =
      succeeded.length > 0 ? "success" : failures.length > 0 ? "failed" : "skipped";
    const trendStageError = failures.length
      ? failures.map((entry) => `${entry.source}: ${entry.result.error ?? "unknown"}`).join(" | ")
      : undefined;

    stageLog.push({
      stage: "trendCollect",
      status: trendStageStatus,
      durationMs: Date.now() - trendStartedAt,
      error: trendStageError,
    });

    // seed_queries(static) + trend_candidates(dynamic, Creator Advisor)를 합친 daily query pool.
    // Creator Advisor가 disabled이거나 실패해도 buildDailyQueryPool()은 예외를 던지지 않고
    // seed_queries만으로 구성된 결과를 반환한다 - 그래서 이 "seed" 단계의 성공/실패 여부는
    // 기존과 동일하게 seed_queries 조회 성패에만 좌우된다.
    const queryPool = await runStage(stageLog, "seed", () =>
      buildDailyQueryPool({
        enabledSources: options.collectionSources,
        includeSeedQueries: options.includeSeedQueries,
      })
    );
    if (!queryPool) {
      skipRemaining(stageLog, ["collect", "relevance", "cluster", "rank", "competition", "save", "notify"]);
      return result;
    }
    result.queryPool = queryPool;
    if (queryPool.trendCount > 0) {
      const bySource = Object.entries(queryPool.trendCountBySource)
        .map(([source, count]) => `${source} ${count}`)
        .join(", ");
      console.log(
        `ℹ️ [dailyKeywordWorkflow] query pool: seed ${queryPool.seedCount}건 + trend ${queryPool.trendCount}건 (${bySource})`
      );
    }

    queries = queryPool.entries.map((entry) => entry.keyword);
    seedCategoryByQuery = Object.fromEntries(queryPool.entries.map((entry) => [entry.keyword, entry.category]));
    seedPriorityByQuery = Object.fromEntries(queryPool.entries.map((entry) => [entry.keyword, entry.priority]));
    stableSeedTerms = queryPool.entries
      .filter((entry) => entry.origin === "seed" || entry.origin === "merged")
      .map((entry) => entry.keyword);
  }

  const collectOptions: CollectCandidatesOptions = {
    ...options.collectOptions,
    categoryByQuery: { ...seedCategoryByQuery, ...options.collectOptions?.categoryByQuery },
  };

  const collected = await runStage(stageLog, "collect", () => collectCandidates(queries!, collectOptions));
  if (!collected) {
    skipRemaining(stageLog, ["relevance", "cluster", "rank", "competition", "save", "notify"]);
    return result;
  }
  result.collected = collected;

  const relevance = await runStage(stageLog, "relevance", async () =>
    filterRelevantCandidates(collected.candidates)
  );
  if (!relevance) {
    skipRemaining(stageLog, ["cluster", "rank", "competition", "save", "notify"]);
    return result;
  }
  result.relevance = relevance;

  const clusters = await runStage(stageLog, "cluster", async () =>
    clusterKeywords(relevance.candidates, options.clusterer)
  );
  if (!clusters) {
    skipRemaining(stageLog, ["rank", "competition", "save", "notify"]);
    return result;
  }
  result.clusters = clusters;

  // 같은 이슈가 여러 cluster로 쪼개진 것을 합친다. 기본은 **preview만** - 무엇이 합쳐질지
  // 로그로 남기고 실제 cluster는 그대로 둔다(clustering 변경은 승인 필요 항목).
  // mergeSameTopicClusters.ts 상단에 실측 근거가 있다.
  let effectiveClusters = clusters;
  if (TOPIC_MERGE_CONFIG.previewEnabled && clusters.length > 1) {
    const topicMerge = mergeSameTopicClusters(clusters, { categoryTerms: stableSeedTerms });
    result.topicMerge = topicMerge;

    if (topicMerge.mergedGroups.length > 0) {
      const mode = TOPIC_MERGE_CONFIG.applyToClusters ? "적용" : "preview";
      console.log(
        `ℹ️ [주제병합/${mode}] ${clusters.length}개 cluster 중 ${topicMerge.mergedGroups.length}개 그룹이 ` +
          `같은 주제로 판정됨 (${clusters.length} -> ${topicMerge.clusters.length}개)`
      );
      for (const group of topicMerge.mergedGroups) {
        console.log(`   • ${group.representativeKeyword} (항목 ${group.mergedItemCount}건)`);
        for (const member of group.memberKeywords) console.log(`     - ${member}`);
      }
    }

    if (TOPIC_MERGE_CONFIG.applyToClusters) {
      effectiveClusters = topicMerge.clusters;
      result.clusters = topicMerge.clusters;
    }
  }

  const rankOptions: RankKeywordsOptions = {
    ...options.rankOptions,
    priorityByQuery: {
      ...seedPriorityByQuery,
      ...options.rankOptions?.priorityByQuery,
    },
    categoryTerms: options.rankOptions?.categoryTerms ?? stableSeedTerms,
  };
  const ranked = await runStage(stageLog, "rank", () => rankKeywords(effectiveClusters, queries!, rankOptions));
  if (!ranked) {
    skipRemaining(stageLog, ["competition", "save", "notify"]);
    return result;
  }
  result.ranked = ranked;

  // ---------- competition (관측 전용) ----------
  // 최종 Top N의 "블로그 문서 총 개수"를 측정한다. Phase A에서는 점수에 반영하지 않는다 -
  // 임계값(몇 건부터 포화인가)을 정할 근거가 아직 없어 실제 분포를 먼저 모으는 단계다.
  // 실패해도 파이프라인을 멈추지 않는다(보조 관측 신호). config/keywordCompetition.ts 참고.
  let competitionTargets: { rank: number; keyword: string; query: string; total: number | null }[] = [];
  const competitionStartedAt = Date.now();
  if (BLOG_COMPETITION_CONFIG.enabled && ranked.rankings.length > 0) {
    // canonical keyword를 그대로 조회하면 문장 전체를 검색하게 되어 "주제 포화도"가 아니라
    // "이 어투를 쓴 블로그 수"를 재게 된다(buildCompetitionQuery.ts 상단 실측 근거).
    // 핵심 명사 2개로 줄여 조회한다.
    const targets = ranked.rankings.map((item) => ({
      rank: item.rank,
      keyword: item.keyword,
      query: buildCompetitionQuery(item.keyword),
    }));

    const competition = await probeBlogCompetition(targets.map((target) => target.query));
    result.competition = competition;

    competitionTargets = targets.map((target) => ({
      ...target,
      total: competition.totalByKeyword.get(target.query) ?? null,
    }));

    for (const target of competitionTargets) {
      const saturation = computeSaturation(target.total);
      console.log(
        `ℹ️ [경쟁도] #${target.rank} [${target.query}] — 블로그 ${target.total ?? "?"}건 ` +
          `(${describeSaturation(saturation)}${saturation === null ? "" : `, ${saturation.toFixed(2)}`}) ` +
          `← ${target.keyword}`
      );
    }

    stageLog.push({
      stage: "competition",
      status: competition.status === "failed" ? "failed" : "success",
      durationMs: Date.now() - competitionStartedAt,
      error: competition.failedCount > 0 ? `${competition.failedCount}건 조회 실패` : undefined,
    });
  } else {
    stageLog.push({ stage: "competition", status: "skipped", durationMs: 0 });
  }

  const apiErrors: Partial<Record<string, string>> = { ...collected.sourceErrors };
  if (ranked.trendError) apiErrors.naver_trend = ranked.trendError;

  const saved = await runStage(stageLog, "save", () =>
    saveRankingHistoryStage({
      startedAt,
      seedQueries: queries!,
      metadata: {
        workflow: "dailyKeywordWorkflow",
        relevanceFilter: {
          totalBefore: relevance.totalBefore,
          totalAfter: relevance.totalAfter,
          droppedCount: relevance.droppedCount,
        },
        // Phase A 관측 데이터. 며칠치가 쌓이면 이 분포로 포화도 임계값을 확정한다
        // (config/keywordCompetition.ts의 low/highTotalThreshold는 그때까지 잠정치).
        ...(result.competition
          ? {
              blogCompetition: {
                status: result.competition.status,
                probedCount: result.competition.probedCount,
                failedCount: result.competition.failedCount,
                // keyword(원문)와 query(실제 조회한 핵심어)를 함께 남긴다 - 나중에 임계값을
                // 재검토할 때 어떤 축약이 적용됐는지 알아야 하기 때문이다.
                entries: competitionTargets,
              },
            }
          : {}),
        ...options.metadata,
      },
      candidatesCount: collected.candidates.length,
      clustersCount: clusters.length,
      errorCount: Object.keys(apiErrors).length,
      ranked: ranked.rankings,
    })
  );
  if (!saved) {
    skipRemaining(stageLog, ["notify"]);
    return result;
  }
  result.saved = saved;

  const runId = saved.runId;
  if (runId === null) {
    // saveRankingHistory 자체는 예외 없이 끝났지만(예: discovery_runs insert만 성공하고 이후 단계 실패)
    // runId가 없으면 알림이 참조할 run이 없으므로 notify는 skip 처리한다.
    stageLog.push({
      stage: "notify",
      status: "skipped",
      durationMs: 0,
      error: saved.error ?? "saveRankingHistory가 runId를 반환하지 않음",
    });
    return result;
  }

  const notification = await runStage(stageLog, "notify", () =>
    sendTelegramNotification(runId, options.notifyOptions)
  );
  result.notification = notification;

  return result;
}
