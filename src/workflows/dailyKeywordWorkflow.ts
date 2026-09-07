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
import { shouldExcludeCandidate } from "../config/keywordExclusionRules.js";
import { runCommunityCollection } from "./community/runCommunityCollection.js";
import { runCreatorAdvisorCollection } from "./creator-advisor/runCreatorAdvisorCollection.js";
import { runGoogleTrendsCollection } from "./google-trends/runGoogleTrendsCollection.js";
import { runDaumRealtimeCollection } from "./daum-realtime/runDaumRealtimeCollection.js";
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
import { computeSaturation, describeSaturation } from "./keyword-ranking/computeCompetitionScore.js";
import { extractTopicQueries } from "./keyword-ranking/extractTopicQueries.js";
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
  RunDaumRealtimeCollectionOptions,
  RunDaumRealtimeCollectionResult,
} from "./daum-realtime/runDaumRealtimeCollection.js";
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
  const result = await collectNaverCandidates(queries, options);

  // 육아 카테고리·정치 키워드는 수집 단계에서 원천 차단한다(2026-09-07 채널 개편). seed_queries에
  // 등록된 상시 검색어(예: "육아지원금")가 아직 남아 있어도 여기서 걸러지므로 Top N/알림까지
  // 올라가지 않는다 - trend_candidates 경로(excludeCandidateInserts.ts)와 같은 규칙을 쓴다.
  const filtered = result.candidates.filter(
    (candidate) => !shouldExcludeCandidate(candidate.keyword, candidate.category)
  );
  const excludedCount = result.candidates.length - filtered.length;
  if (excludedCount > 0) {
    console.log(
      `ℹ️ collectCandidates: 제외 대상(육아·정치) ${excludedCount}건을 걸렀습니다 (${result.candidates.length}건 -> ${filtered.length}건).`
    );
  }

  return { ...result, candidates: filtered };
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
  /**
   * 경쟁도 측정기. 생략하면 측정 자체를 하지 않는다(순수 채점만 - 기존 테스트가 이 경로를 쓴다).
   * 주입식으로 둔 이유: 실제 구현은 헤드리스 LLM + NAVER API를 타므로, 테스트에서 fake로 바꿔
   * 외부 호출 없이 재정렬 로직만 검증할 수 있어야 한다.
   */
  competition?: {
    /** 상위 몇 건을 잴지. 400개 전부는 못 재고, 하위권은 어차피 Top N에 못 든다. */
    probeTopN: number;
    run: (
      items: { keyword: string; headline: string }[]
    ) => Promise<Map<string, { query: string; total: number | null; source: string }>>;
  };
};

/** 경쟁도 측정 결과 1건. applied=false여도 scoreAfter를 채워 "반영하면 어떻게 되는지"를 보여준다. */
export type RankCompetitionEntry = {
  keyword: string;
  query: string | null;
  querySource: string | null;
  blogTotal: number | null;
  scoreBefore: number;
  scoreAfter: number;
};

export type RankCompetitionInfo = {
  entries: RankCompetitionEntry[];
  /** 이번 run에서 실제로 점수에 반영했는지(BLOG_COMPETITION_CONFIG.applyToScore). */
  applied: boolean;
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
  /** 경쟁도 측정 결과. options.competition을 넘기지 않았으면 null. */
  competition: RankCompetitionInfo | null;
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

  let scoredSortedDesc = scored.slice().sort((a, b) => b.totalScore - a.totalScore);

  // ---------- 경쟁도 측정 + (설정 시) 재채점 ----------
  // **다양성 선정 전에 해야 한다.** 최종 Top N이 정해진 뒤에 재면 순위를 바꿀 수 없다.
  // 상위 후보만 잰다 - 400개 cluster를 전부 조회할 수는 없고, 하위권은 어차피 Top N에 못 든다.
  //
  // applyToScore가 꺼져 있으면(기본) 측정만 하고 점수에는 반영하지 않는다. 그때도 프로브는 도는데,
  // 관측 데이터를 모으고 "반영하면 어떻게 바뀌는지" preview를 보여주기 위해서다.
  let competition: RankCompetitionInfo | null = null;
  if (options.competition) {
    const probeCount = Math.min(options.competition.probeTopN, scoredSortedDesc.length);
    const probeTargets = scoredSortedDesc.slice(0, probeCount);

    const measured = await options.competition.run(
      probeTargets.map((item) => ({
        keyword: item.ranked.keyword,
        headline: item.ranked.headline,
      }))
    );

    const entries: RankCompetitionEntry[] = [];
    for (const item of probeTargets) {
      const found = measured.get(item.ranked.keyword);
      // 측정된 항목만 blogDocumentTotal을 채운다. 프로브 범위 밖 후보는 undefined로 남아
      // scoreKeyword가 기존 로직을 쓴다(같은 잣대로 비교하기 위함 - scoreKeyword 주석 참고).
      const input = inputsWithPercentiles.find((i) => i.keyword === item.ranked.keyword);
      // 전역 플래그와 무관하게 "기회도를 쓰면 몇 점인지"를 계산한다 - 이 값이 preview의 내용이다.
      // 실제 채택 여부는 아래 applyToScore가 정한다.
      const rescored =
        input && found
          ? scoreKeyword({ ...input, blogDocumentTotal: found.total }, { useContentOpportunity: true })
          : null;

      entries.push({
        keyword: item.ranked.keyword,
        query: found?.query ?? null,
        querySource: found?.source ?? null,
        blogTotal: found?.total ?? null,
        scoreBefore: item.totalScore,
        scoreAfter: rescored?.total ?? item.totalScore,
      });

      if (BLOG_COMPETITION_CONFIG.applyToScore && rescored) {
        item.totalScore = rescored.total;
        item.ranked = { ...item.ranked, totalScore: rescored.total, scoreBreakdown: rescored };
      }
    }

    competition = { entries, applied: BLOG_COMPETITION_CONFIG.applyToScore };

    if (BLOG_COMPETITION_CONFIG.applyToScore) {
      scoredSortedDesc = scoredSortedDesc.slice().sort((a, b) => b.totalScore - a.totalScore);
    }
  }

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

  return { rankings, preDiversityRankings, scoreRange, mergedClusterCount, trendError, competition };
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
  /** 다음 실시간 트렌드 수집 단계(trendCollect)에 그대로 전달된다. */
  daumRealtimeOptions?: RunDaumRealtimeCollectionOptions;
  /** 커뮤니티(더쿠 등) 수집 단계(trendCollect)에 그대로 전달된다. */
  communityOptions?: RunCommunityCollectionOptions;
  /**
   * 이번 run에서 수집·조회할 동적 트렌드 소스. 생략하면 네 소스 모두(현행 동작).
   * - 오전 job들: ["creator_advisor", "google_trends", "daum_realtime"] — 커뮤니티는 오후로 분리(2026-08-31)
   * - 오후 커뮤니티 job: ["community"]
   * trendCollect 단계에서 어떤 수집기를 돌릴지, buildDailyQueryPool이 어떤 source의 trend_candidates를
   * 읽을지를 함께 결정한다(오후 run이 오전에 쌓인 creator_advisor 후보를 다시 태우지 않도록).
   */
  collectionSources?: readonly TrendSource[];
  /** buildDailyQueryPool에 그대로 전달. false면 seed_queries를 빼고 동적 소스만으로 pool을 만든다(오후 커뮤니티 전용). */
  includeSeedQueries?: boolean;
  /**
   * 지정하면 query pool을 이 category 목록으로만 좁힌다(2026-09-07 채널 전담제 - 사회이슈/연예·OTT
   * 알림을 분리하기 위함). NAVER 실시간 검색(collect 단계)도 이 필터를 거친 query로만 호출되므로
   * 다른 카테고리 몫까지 검색량을 낭비하지 않는다. 생략하면 필터링 없음(기존 동작).
   */
  includeCategories?: readonly string[];
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
  /** 다음 실시간 트렌드 수집 결과. 위와 같다. disabled면 status="skipped". */
  daumRealtimeCollection: RunDaumRealtimeCollectionResult | null;
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
  /**
   * 경쟁도 측정 결과는 `ranked.competition`에 들어 있다 - 측정이 다양성 선정 전에 일어나야
   * 순위에 반영될 수 있어 rankKeywords 안으로 옮겼기 때문이다.
   */
  ranked: RankKeywordsResult | null;
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
    daumRealtimeCollection: null,
    communityCollection: null,
    queryPool: null,
    collected: null,
    relevance: null,
    clusters: null,
    topicMerge: null,
    ranked: null,
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

    // 이번 run이 다룰 동적 소스. 생략하면 네 소스 모두(현행). 오전 job들은 커뮤니티를 빼고,
    // 오후 커뮤니티 job은 community 하나만 넘긴다(2026-08-31, 발송 2회 분리). daum_realtime은
    // 2026-09-08 추가 - 사회이슈/연예 두 오전 job 모두에 자동으로 나뉘어 들어간다(카테고리
    // 분류가 라우팅을 대신하므로 이 소스 자체를 특정 job 전용으로 두지 않는다).
    const collectionSources: readonly TrendSource[] =
      options.collectionSources ?? ["creator_advisor", "google_trends", "daum_realtime", "community"];
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

    const daumRealtimeCollection = await runDaumRealtimeCollection(
      collectionSources.includes("daum_realtime") ? options.daumRealtimeOptions : { ...options.daumRealtimeOptions, ...forceSkip }
    );
    result.daumRealtimeCollection = daumRealtimeCollection;

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
    if (daumRealtimeCollection.status === "success") {
      console.log(
        `ℹ️ [dailyKeywordWorkflow] 다음 실시간 트렌드 수집: ${daumRealtimeCollection.fetchedCount}건 조회 → ` +
          `${daumRealtimeCollection.upsertedCount}건 저장 (trendDate: ${daumRealtimeCollection.trendDate ?? "N/A"}, 만료 ${daumRealtimeCollection.expiredCount}건)`
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
      { source: "daum_realtime", result: daumRealtimeCollection },
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

    const scopedEntries = options.includeCategories
      ? queryPool.entries.filter((entry) => options.includeCategories!.includes(entry.category))
      : queryPool.entries;
    if (options.includeCategories) {
      console.log(
        `ℹ️ [dailyKeywordWorkflow] category 필터(${options.includeCategories.join(", ")}) 적용: ` +
          `${queryPool.entries.length}건 -> ${scopedEntries.length}건`
      );
    }

    queries = scopedEntries.map((entry) => entry.keyword);
    seedCategoryByQuery = Object.fromEntries(scopedEntries.map((entry) => [entry.keyword, entry.category]));
    seedPriorityByQuery = Object.fromEntries(scopedEntries.map((entry) => [entry.keyword, entry.priority]));
    stableSeedTerms = scopedEntries
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

  // 경쟁도 측정기. 다양성 선정 전에 상위 후보를 재도록 rankKeywords에 주입한다 -
  // 최종 Top N이 정해진 뒤에 재면 순위를 바꿀 수 없기 때문이다.
  // 실패해도 예외를 던지지 않는다(보조 신호). 측정 못 한 항목은 blogDocumentTotal이 비어
  // scoreKeyword가 기존 로직을 쓴다.
  const competitionRunner: NonNullable<RankKeywordsOptions["competition"]> = {
    probeTopN: BLOG_COMPETITION_CONFIG.probeMaxKeywords,
    run: async (items) => {
      const measured = new Map<string, { query: string; total: number | null; source: string }>();

      // canonical keyword를 그대로 조회하면 문장 전체를 검색해 "주제 포화도"가 아니라
      // "이 어투를 쓴 블로그 수"를 재게 된다. 규칙 기반 축약도 한국어 head-final 구조 때문에
      // 실패했다(extractTopicQueries.ts 상단 실측). LLM으로 주제구를 뽑는다 - 호출 1회.
      const extraction = await extractTopicQueries(items);
      if (extraction.error) {
        console.log(`ℹ️ [주제어 추출] ${extraction.status} - ${extraction.error}`);
      }

      const probe = await probeBlogCompetition(extraction.queries.map((q) => q.query));
      if (probe.failedCount > 0) {
        console.log(`ℹ️ [경쟁도] ${probe.failedCount}건 조회 실패(해당 항목은 기존 채점 유지)`);
      }

      extraction.queries.forEach((entry, index) => {
        measured.set(items[index].keyword, {
          query: entry.query,
          total: probe.totalByKeyword.get(entry.query) ?? null,
          source: entry.source,
        });
      });

      return measured;
    },
  };

  const rankOptions: RankKeywordsOptions = {
    ...options.rankOptions,
    priorityByQuery: {
      ...seedPriorityByQuery,
      ...options.rankOptions?.priorityByQuery,
    },
    categoryTerms: options.rankOptions?.categoryTerms ?? stableSeedTerms,
    competition:
      options.rankOptions?.competition ??
      (BLOG_COMPETITION_CONFIG.enabled ? competitionRunner : undefined),
  };
  const ranked = await runStage(stageLog, "rank", () => rankKeywords(effectiveClusters, queries!, rankOptions));
  if (!ranked) {
    skipRemaining(stageLog, ["competition", "save", "notify"]);
    return result;
  }
  result.ranked = ranked;

  // ---------- competition 로그 ----------
  // 실제 측정은 rankKeywords 안에서 끝났다(다양성 선정 전이어야 순위에 반영될 수 있으므로).
  // 여기서는 결과를 사람이 읽을 수 있게 남긴다. applied=false면 "반영하면 어떻게 되는지"만 보여준다.
  const competitionStartedAt = Date.now();
  if (ranked.competition) {
    const { entries, applied } = ranked.competition;
    const changed = entries.filter((entry) => entry.scoreAfter !== entry.scoreBefore);

    console.log(
      `ℹ️ [경쟁도/${applied ? "적용" : "preview"}] ${entries.length}건 측정, ` +
        `점수가 달라지는 항목 ${changed.length}건`
    );
    for (const entry of entries.slice(0, 15)) {
      const saturation = computeSaturation(entry.blogTotal);
      const delta =
        entry.scoreAfter === entry.scoreBefore
          ? ""
          : ` | ${entry.scoreBefore}점 → ${entry.scoreAfter}점`;
      console.log(
        `   [${entry.query ?? "?"}]${entry.querySource === "fallback" ? "(폴백)" : ""} ` +
          `블로그 ${entry.blogTotal ?? "?"}건 (${describeSaturation(saturation)})${delta}  ← ${entry.keyword}`
      );
    }

    stageLog.push({
      stage: "competition",
      status: "success",
      durationMs: Date.now() - competitionStartedAt,
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
        // 경쟁도 관측 데이터. keyword(원문)·query(실제 조회한 주제어)·출처·전후 점수를 함께
        // 남긴다 - 나중에 임계값을 재검토할 때 어떤 추출이 적용됐는지 알아야 하기 때문이다.
        ...(ranked.competition
          ? {
              blogCompetition: {
                applied: ranked.competition.applied,
                entries: ranked.competition.entries,
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
