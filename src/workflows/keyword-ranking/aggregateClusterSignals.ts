// cluster(같은 이슈로 묶인 KeywordCandidate 묶음) + query별 trend momentum을 결합해
// scoreKeyword()가 바로 사용할 수 있는 KeywordScoreInput을 만든다.
// 또한 headline(cluster 대표 원문)에서 canonical keyword를 생성하고, cluster에 섞인 seed query 중
// trend 데이터를 연결할 대표 query를 선택한다.

import type { KeywordCandidate, KeywordSource } from "../../types/keywordDiscovery.js";
import type { KeywordScoreInput, TrendDirection } from "../../types/keywordScoring.js";
import { TREND_MOMENTUM_CONFIG } from "../../config/keywordScoring.js";
import { buildCanonicalKeyword } from "./canonicalKeyword.js";
import { resolveClusterAttribution } from "./clusterAttribution.js";
import type { KeywordCluster } from "./clustering/KeywordClusterer.js";
import type { TrendMomentum } from "./fetchTrendMomentum.js";

export type TrendMomentumByQuery = Map<string, TrendMomentum>;

// (latest - previous) / max(|previous|, minBaselineRatio) * 100.
// ratio는 키워드마다 자기 자신의 최대치 기준으로 정규화되어 스케일이 서로 다르므로(예: "넷플릭스"는 0~100대,
// "육아지원금"은 0~1 미만), 절대 delta가 아니라 직전 값 대비 변화율(%)로 정규화해야 키워드 검색량 규모와
// 무관하게 공정하게 비교할 수 있다. previous가 0에 가까우면 변화율이 폭발적으로 커지므로 baseline에 하한을 둔다.
// debug 스크립트(debug/trendMomentumDebug.ts)에서도 재사용할 수 있도록 export한다.
export function computeTrendDeltaPercent(
  latestRatio: number | null,
  previousRatio: number | null
): number | null {
  if (latestRatio === null || previousRatio === null) return null;
  const baseline = Math.max(Math.abs(previousRatio), TREND_MOMENTUM_CONFIG.minBaselineRatio);
  return ((latestRatio - previousRatio) / baseline) * 100;
}

// rising/accelerating/falling/flat: 단기 변화율(%)과 중기 변화율(%)을 함께 봐서 판정한다.
// 둘 다 절대 ratio가 아니라 "직전 값/구간 대비 %"라서 키워드 검색량 규모와 무관하게 공정하게 비교된다.
// - accelerating: 중기 추세도 상승 + 최근 delta도 상승(추세가 가속되는 중).
// - rising: 중기 추세 또는 단기 delta 중 하나라도 뚜렷한 상승.
// - falling: 중기 변화율이 뚜렷한 하락(중기 데이터가 없으면 단기 delta로 대체 판정).
// - flat: 위 어디에도 해당하지 않음.
// debug 스크립트(debug/trendMomentumDebug.ts)에서도 동일한 판정 로직을 재사용할 수 있도록 export한다.
export function resolveTrendDirection(
  deltaPercent: number | null,
  midChangePercent: number | null
): TrendDirection {
  if (deltaPercent === null && midChangePercent === null) return "unknown";

  const isRisingDelta =
    deltaPercent !== null && deltaPercent > TREND_MOMENTUM_CONFIG.risingDirectionThresholdPercent;
  const isRisingMid =
    midChangePercent !== null && midChangePercent > TREND_MOMENTUM_CONFIG.risingMidThresholdPercent;
  const isFallingMid =
    midChangePercent !== null && midChangePercent < TREND_MOMENTUM_CONFIG.fallingMidThresholdPercent;
  const isFallingDelta =
    deltaPercent !== null && deltaPercent < TREND_MOMENTUM_CONFIG.fallingDirectionThresholdPercent;

  if (isRisingMid && isRisingDelta) return "accelerating";
  if (isRisingMid || isRisingDelta) return "rising";
  if (midChangePercent !== null ? isFallingMid : isFallingDelta) return "falling";
  return "flat";
}

export function aggregateClusterSignals(
  cluster: KeywordCluster<KeywordCandidate>,
  trendMomentumByQuery: TrendMomentumByQuery,
  priorityByQuery: Record<string, number> = {}
): KeywordScoreInput {
  const { items } = cluster;

  const attribution = resolveClusterAttribution(items, priorityByQuery);
  const sources = attribution.sources as KeywordSource[];
  const newsCount = items.filter((item) => item.source === "naver_news").length;
  const blogCount = items.filter((item) => item.source === "naver_blog").length;
  const webCount = items.filter((item) => item.source === "naver_web").length;

  const publishedDates = items
    .map((item) => item.publishedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const earliestPublishedAt = publishedDates[0] ?? null;
  const latestPublishedAt = publishedDates[publishedDates.length - 1] ?? null;

  // naver_web은 publishedAt을 제공하지 않으므로, cluster 안에 news/blog가 하나도 없으면
  // publishedDates가 비어 latestPublishedAt=null이 된다. 이 경우를 "정보 없음"으로 명시적으로 표시해
  // scoreFreshness()가 실제 오래됨(0점)과 구분해서 처리할 수 있게 한다.
  const hasTimestampData = publishedDates.length > 0;

  const headline = attribution.headline;
  const keyword = buildCanonicalKeyword(headline);

  const { seedQuery, category, selectionNote: seedQuerySelectionNote } = attribution;
  const momentum = seedQuery ? trendMomentumByQuery.get(seedQuery) : undefined;

  const trendLatestRatio = momentum?.latestRatio ?? null;
  const trendPreviousRatio = momentum?.previousRatio ?? null;
  const trendShortAverage = momentum?.shortAverage ?? null;
  const trendPreviousAverage = momentum?.previousAverage ?? null;
  const trendSlope = momentum?.slope ?? null;
  const trendShortTermChangePercent = momentum?.shortTermChangePercent ?? null;
  const trendDeltaPercent = computeTrendDeltaPercent(trendLatestRatio, trendPreviousRatio);

  return {
    keyword,
    headline,
    seedQuery,
    seedQuerySelectionNote,
    category,
    sources,
    relatedCount: items.length,
    newsCount,
    blogCount,
    webCount,
    earliestPublishedAt,
    latestPublishedAt,
    trendLatestRatio,
    trendPreviousRatio,
    trendShortAverage,
    trendPreviousAverage,
    trendSlope,
    trendDeltaPercent,
    trendShortTermChangePercent,
    trendDirection: resolveTrendDirection(trendDeltaPercent, trendShortTermChangePercent),
    // batch percentile은 아직 이 시점(단일 cluster 처리)에서는 계산할 수 없다.
    // computeBatchPercentiles()가 전체 batch를 모아서 채워 넣는다.
    newsCountPercentile: 0,
    contentCountPercentile: 0,
    hasTimestampData,
  };
}
