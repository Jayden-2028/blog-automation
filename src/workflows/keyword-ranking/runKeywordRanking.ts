// Keyword Ranking 파이프라인 orchestration.
// 흐름: 수집(collectNaverCandidates) -> cluster -> trend momentum 결합 -> batch percentile 계산
//      -> scoring -> 정렬 -> Top N -> ranking history 저장(discovery_runs/keyword_rankings).
// 최종 반환 구조는 n8n/Telegram 등 외부 소비자가 바로 사용할 수 있도록 { runId, generatedAt, summary, rankings }로 고정한다.

import { collectNaverCandidates } from "../keyword-discovery/collectNaverCandidates.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";
import type { KeywordScoreInput, RankedKeyword } from "../../types/keywordScoring.js";
import { aggregateClusterSignals } from "./aggregateClusterSignals.js";
import { buildReason } from "./buildReason.js";
import { CompositeSimilarityClusterer } from "./clustering/CompositeSimilarityClusterer.js";
import type { KeywordClusterer } from "./clustering/KeywordClusterer.js";
import { computeBatchPercentiles } from "./computeBatchPercentiles.js";
import { fetchTrendMomentumByQuery } from "./fetchTrendMomentum.js";
import { saveRankingHistory } from "./saveRankingHistory.js";
import { scoreKeyword } from "./scoreKeyword.js";

export type RunKeywordRankingOptions = {
  /** query당 API별로 가져올 결과 개수. 실제 API 테스트 시에는 소량(5 정도) 권장. 기본 10. */
  displayPerQuery?: number;
  /** query 간 순차 호출 사이에 둘 지연 시간(ms). rate limit 보호용. 기본 150ms. */
  requestDelayMs?: number;
  categoryByQuery?: Record<string, string>;
  /** 검색어트렌드 momentum 비교를 위한 조회 기간(일). 기본 14일. */
  trendRangeDays?: number;
  /** 반환할 상위 키워드 개수. 기본 10. */
  topN?: number;
  /** clustering 구현 교체용 (기본 CompositeSimilarityClusterer). */
  clusterer?: KeywordClusterer;
  /** 대표 seedQuery 동률 판정에만 사용하는 query별 운영 priority. */
  priorityByQuery?: Record<string, number>;
  /** discovery_runs/keyword_rankings에 이력을 저장할지 여부. 기본 true. */
  saveHistory?: boolean;
};

export type KeywordRankingSummary = {
  queries: string[];
  candidatesCount: number;
  clustersCount: number;
  /** 2건 이상의 후보가 하나로 합쳐진 cluster 개수 (clustering이 실제로 병합을 일으킨 이슈 수). */
  mergedClusterCount: number;
  /** 전체 scored cluster 기준 총점 범위 (top N으로 자르기 전). scored 대상이 없으면 null. */
  scoreRange: { min: number; max: number } | null;
  /** naver_news / naver_blog / naver_web / naver_trend 수집 단계 오류. */
  apiErrors: Partial<Record<string, string>>;
  historySaved: boolean;
  historyError?: string;
};

export type KeywordRankingResult = {
  runId: number | null;
  generatedAt: string;
  summary: KeywordRankingSummary;
  rankings: RankedKeyword[];
};

type ScoredCluster = {
  input: KeywordScoreInput;
  ranked: Omit<RankedKeyword, "rank">;
};

export async function runKeywordRanking(
  queries: string[],
  options: RunKeywordRankingOptions = {}
): Promise<KeywordRankingResult> {
  const startedAt = new Date();
  const topN = options.topN ?? 10;
  const clusterer = options.clusterer ?? new CompositeSimilarityClusterer();
  const saveHistory = options.saveHistory ?? true;

  const collected = await collectNaverCandidates(queries, {
    displayPerQuery: options.displayPerQuery,
    requestDelayMs: options.requestDelayMs,
    categoryByQuery: options.categoryByQuery,
  });

  const { momentumByQuery, error: trendError } = await fetchTrendMomentumByQuery(queries, {
    rangeDays: options.trendRangeDays,
  });

  const apiErrors: Partial<Record<string, string>> = { ...collected.sourceErrors };
  if (trendError) apiErrors.naver_trend = trendError;

  const clusters = clusterer.cluster<KeywordCandidate>(collected.candidates);

  const rawInputs = clusters.map((cluster) =>
    aggregateClusterSignals(cluster, momentumByQuery, options.priorityByQuery)
  );
  const inputsWithPercentiles = computeBatchPercentiles(rawInputs);

  const scored: ScoredCluster[] = inputsWithPercentiles.map((input) => {
    const scoreBreakdown = scoreKeyword(input);
    return {
      input,
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
      },
    };
  });

  const scoreRange =
    scored.length > 0
      ? scored.reduce(
          (range, item) => ({
            min: Math.min(range.min, item.ranked.totalScore),
            max: Math.max(range.max, item.ranked.totalScore),
          }),
          { min: scored[0].ranked.totalScore, max: scored[0].ranked.totalScore }
        )
      : null;

  const rankings: RankedKeyword[] = scored
    .sort((a, b) => b.ranked.totalScore - a.ranked.totalScore)
    .slice(0, topN)
    .map((item, index) => ({ rank: index + 1, ...item.ranked }));

  const mergedClusterCount = clusters.filter((cluster) => cluster.items.length > 1).length;
  const errorCount = Object.keys(apiErrors).length;

  let runId: number | null = null;
  let historySaved = false;
  let historyError: string | undefined;

  if (saveHistory) {
    const historyResult = await saveRankingHistory({
      startedAt,
      seedQueries: queries,
      metadata: {
        displayPerQuery: options.displayPerQuery,
        trendRangeDays: options.trendRangeDays,
        topN,
      },
      candidatesCount: collected.candidates.length,
      clustersCount: clusters.length,
      errorCount,
      ranked: rankings,
    });
    runId = historyResult.runId;
    historySaved = historyResult.persisted;
    historyError = historyResult.error;
  }

  return {
    runId,
    generatedAt: new Date().toISOString(),
    summary: {
      queries,
      candidatesCount: collected.candidates.length,
      clustersCount: clusters.length,
      mergedClusterCount,
      scoreRange,
      apiErrors,
      historySaved,
      historyError,
    },
    rankings,
  };
}
