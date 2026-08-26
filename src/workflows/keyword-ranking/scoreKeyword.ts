// KeywordScoreInput -> KeywordScoreBreakdown (0~100) 순수 함수.
// 가중치/임계값은 전부 src/config/keywordScoring.ts에서 가져오며 이 파일에는 숫자를 두지 않는다.

import {
  CLICK_POTENTIAL_CONFIG,
  CONTENT_DEMAND_CONFIG,
  CROSS_SOURCE_CONFIG,
  FRESHNESS_CONFIG,
  KEYWORD_SCORE_WEIGHTS,
  NEWS_VELOCITY_CONFIG,
  TREND_MOMENTUM_CONFIG,
} from "../../config/keywordScoring.js";
import type { KeywordScoreBreakdown, KeywordScoreInput } from "../../types/keywordScoring.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hoursSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return null;
  return clamp((now.getTime() - timestamp) / (1000 * 60 * 60), 0, Number.POSITIVE_INFINITY);
}

// A. Trend Momentum (기본 30점): 단기 변화율(deltaPercent)과 중기 변화율(shortTermChangePercent)을
// 각각 0~1로 정규화한 뒤 가중합한다.
// 예전에는 delta<=0이면 무조건 0점 처리했는데, DataLab 일별 ratio는 실제로 상승 추세라도 특정 하루만
// 소폭 하락하는 경우가 흔해(노이즈) 그 설계가 "진짜 데이터가 있는데도 trend_score가 거의 항상 0"이 되는
// 1차 원인이었다. 또한 절대 ratio-point 임계값(예: 20)으로 정규화하면 검색량이 큰 키워드에만 맞고
// "육아지원금"처럼 ratio가 0~1 미만인 롱테일 키워드는 하루 전체가 바뀌어도 임계값 근처도 못 가 사실상
// 영원히 0점이 되는 2차 원인이 있었다(실측으로 확인됨). 그래서 절대값이 아니라 직전 값/구간 대비
// "변화율(%)"로 정규화해 키워드 검색량 규모와 무관하게 공정하게 비교한다.
// debug 스크립트(debug/trendMomentumDebug.ts)에서도 동일한 계산을 재사용할 수 있도록 순수 함수로 분리한다.
export function computeTrendMomentumScore(
  trendDeltaPercent: number | null,
  trendShortTermChangePercent: number | null
): number {
  const weight = KEYWORD_SCORE_WEIGHTS.trendMomentum;

  if (trendDeltaPercent === null) {
    return Math.round(weight * TREND_MOMENTUM_CONFIG.neutralScoreRatio);
  }

  const shortRatio = clamp(trendDeltaPercent / TREND_MOMENTUM_CONFIG.fullScoreDeltaPercentThreshold, 0, 1);

  let midRatio = 0;
  let shortWeight: number = TREND_MOMENTUM_CONFIG.shortTermWeight;
  let midWeight: number = TREND_MOMENTUM_CONFIG.midTermWeight;

  if (trendShortTermChangePercent !== null) {
    midRatio = clamp(trendShortTermChangePercent / TREND_MOMENTUM_CONFIG.fullScoreMidPercentThreshold, 0, 1);
  } else {
    // 중기 데이터(shortTermChangePercent)가 없으면 단기 신호만으로 재정규화해서 사용한다.
    shortWeight = 1;
    midWeight = 0;
  }

  const combinedRatio = clamp(shortRatio * shortWeight + midRatio * midWeight, 0, 1);
  return Math.round(weight * combinedRatio);
}

function scoreTrendMomentum(input: KeywordScoreInput): number {
  return computeTrendMomentumScore(input.trendDeltaPercent, input.trendShortTermChangePercent);
}

// B. News Velocity (기본 20점): 뉴스 건수의 절대 신호(cap 대비 비율) + batch 내 percentile을 합산하고,
// 가장 최근 뉴스가 recentWindowHours 이내면 가점. 절대 건수만 쓰면 소량 배치에서 1건 vs 0건처럼
// 극단적으로 낮은 값끼리도 사실상 변별력이 없어지므로 상대 순위를 함께 반영한다.
function scoreNewsVelocity(input: KeywordScoreInput, now: Date): number {
  const weight = KEYWORD_SCORE_WEIGHTS.newsVelocity;
  if (input.newsCount === 0) return 0;

  const absoluteRatio = clamp(input.newsCount / NEWS_VELOCITY_CONFIG.countNormalizationCap, 0, 1);
  const combinedRatio = clamp(
    absoluteRatio * NEWS_VELOCITY_CONFIG.absoluteWeight +
      input.newsCountPercentile * NEWS_VELOCITY_CONFIG.percentileWeight,
    0,
    1
  );

  const hoursAgo = hoursSince(input.latestPublishedAt, now);
  const isRecent = hoursAgo !== null && hoursAgo <= NEWS_VELOCITY_CONFIG.recentWindowHours;
  const boostRatio = isRecent
    ? NEWS_VELOCITY_CONFIG.recentBoostRatio
    : NEWS_VELOCITY_CONFIG.staleBoostRatio;

  return Math.round(clamp(weight * combinedRatio * boostRatio, 0, weight));
}

// C. Content Demand (기본 15점): 블로그+웹문서 발생량의 절대 신호 + batch 내 percentile을 합산하고,
// 최근 window 내 활동이면 가점.
function scoreContentDemand(input: KeywordScoreInput, now: Date): number {
  const weight = KEYWORD_SCORE_WEIGHTS.contentDemand;
  const totalCount = input.blogCount + input.webCount;
  if (totalCount === 0) return 0;

  const absoluteRatio = clamp(totalCount / CONTENT_DEMAND_CONFIG.countNormalizationCap, 0, 1);
  const combinedRatio = clamp(
    absoluteRatio * CONTENT_DEMAND_CONFIG.absoluteWeight +
      input.contentCountPercentile * CONTENT_DEMAND_CONFIG.percentileWeight,
    0,
    1
  );

  const hoursAgo = hoursSince(input.latestPublishedAt, now);
  const isRecent = hoursAgo !== null && hoursAgo <= CONTENT_DEMAND_CONFIG.recentWindowHours;
  const boostRatio = isRecent ? 1 + CONTENT_DEMAND_CONFIG.recentBoostRatio : 1;

  return Math.round(clamp(weight * combinedRatio * boostRatio, 0, weight));
}

// D. Freshness (기본 15점): 최근 발행 시각 기준 지수 감쇠(halfLifeHours마다 절반).
// cluster 안에 publishedAt을 제공하는 source가 하나도 없으면(예: web문서만으로 구성) "정보 없음"으로 보고
// neutralScoreRatio를 적용한다 — 0점 처리하면 timestamp가 없다는 이유만으로 부당하게 불리해지기 때문.
function scoreFreshness(input: KeywordScoreInput, now: Date): number {
  const weight = KEYWORD_SCORE_WEIGHTS.freshness;

  if (!input.hasTimestampData) {
    return Math.round(weight * FRESHNESS_CONFIG.neutralScoreRatio);
  }

  const hoursAgo = hoursSince(input.latestPublishedAt, now);
  if (hoursAgo === null || hoursAgo >= FRESHNESS_CONFIG.maxAgeHours) return 0;

  const decay = Math.pow(0.5, hoursAgo / FRESHNESS_CONFIG.halfLifeHours);
  return Math.round(clamp(weight * decay, 0, weight));
}

// E. Cross Source Signal (기본 10점): news/blog/web 중 몇 개 source에 동시에 등장했는지.
function scoreCrossSourceSignal(input: KeywordScoreInput): number {
  const weight = KEYWORD_SCORE_WEIGHTS.crossSourceSignal;
  const uniqueSourceCount = input.sources.length;
  const ratio = CROSS_SOURCE_CONFIG.scoreRatioByUniqueSourceCount[uniqueSourceCount] ?? 0;
  return Math.round(weight * ratio);
}

// F. Click Potential (기본 10점): 규칙 기반 후킹 단어 매칭. 매칭 개수가 늘수록 가점, weight로 clamp.
// canonical keyword(input.keyword)는 축약 과정에서 후킹 단어가 잘려나갈 수 있으므로,
// 원문 정보가 더 풍부한 headline을 기준으로 매칭한다.
function scoreClickPotential(input: KeywordScoreInput): number {
  const weight = KEYWORD_SCORE_WEIGHTS.clickPotential;
  const matchCount = CLICK_POTENTIAL_CONFIG.hookWords.filter((word) =>
    input.headline.includes(word)
  ).length;
  const raw = matchCount * CLICK_POTENTIAL_CONFIG.perMatchScore;
  return Math.round(clamp(raw, 0, weight));
}

export function scoreKeyword(input: KeywordScoreInput): KeywordScoreBreakdown {
  const now = input.now ?? new Date();

  const trendMomentum = scoreTrendMomentum(input);
  const newsVelocity = scoreNewsVelocity(input, now);
  const contentDemand = scoreContentDemand(input, now);
  const freshness = scoreFreshness(input, now);
  const crossSourceSignal = scoreCrossSourceSignal(input);
  const clickPotential = scoreClickPotential(input);

  const total = clamp(
    trendMomentum + newsVelocity + contentDemand + freshness + crossSourceSignal + clickPotential,
    0,
    100
  );

  return {
    trendMomentum,
    newsVelocity,
    contentDemand,
    freshness,
    crossSourceSignal,
    clickPotential,
    total: Math.round(total),
  };
}
