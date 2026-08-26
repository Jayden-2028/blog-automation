// 키워드 랭킹(scoring) 파이프라인 전용 타입.
// keyword-discovery가 만들어낸 KeywordCandidate를 cluster로 묶고 채점한 결과를 표현한다.

import type { KeywordSource } from "./keywordDiscovery.js";

// rising: 최근 상승. accelerating: 중기 추세도 상승 + 최근 delta도 상승(가속). flat: 뚜렷한 방향 없음.
// falling: 중기 추세 하락. unknown: trend 데이터 자체가 없음.
export type TrendDirection = "rising" | "accelerating" | "falling" | "flat" | "unknown";

// 하나의 이슈 cluster를 채점하기 위해 필요한 집계 입력값.
// aggregateClusterSignals()가 KeywordCluster<KeywordCandidate> + trend momentum을 조합해 만든다.
export type KeywordScoreInput = {
  /** canonical keyword (buildCanonicalKeyword()로 headline에서 축약). 포스팅 제목/검색어로 쓰기 위한 짧은 형태. */
  keyword: string;
  /** cluster의 대표 원본 headline (축약 전). click potential 등 원문 신호 판단에는 이 값을 사용한다. */
  headline: string;
  /**
   * 이 cluster의 trend 데이터를 조회하는 데 사용된 원래 seed 검색어. cluster를 구성하는 candidate가
   * 전부 같은 query에서 나왔으면 그 query, 여러 query가 섞였으면 resolveSeedQuery()가 선택한 대표 query.
   * candidate에 query metadata가 전혀 없으면 null.
   */
  seedQuery: string | null;
  /** cluster에 여러 seed query가 섞여 대표 query를 명시적으로 선택해야 했던 경우의 선택 사유. 없으면 null. */
  seedQuerySelectionNote: string | null;
  category: string;
  sources: KeywordSource[];
  relatedCount: number;
  newsCount: number;
  blogCount: number;
  webCount: number;
  earliestPublishedAt: string | null;
  latestPublishedAt: string | null;
  /** 검색어트렌드(DataLab) 최근 기간 ratio (0~100). 조회 실패/데이터 없음이면 null. */
  trendLatestRatio: number | null;
  /** 검색어트렌드 직전 기간 ratio. 비교 대상이 없으면 null. */
  trendPreviousRatio: number | null;
  /** 최근 3개 구간 평균. 데이터가 부족하면 null. */
  trendShortAverage: number | null;
  /** 그 이전 3개 구간 평균. 데이터가 부족하면 null. */
  trendPreviousAverage: number | null;
  /**
   * 최근 구간(최대 7포인트) 선형회귀 기울기(ratio/일). 포인트가 3개 미만이면 null.
   * 참고/디버그 표시용 값이며, 실제 채점(scoreTrendMomentum)과 trendDirection 판정에는 키워드마다
   * ratio 규모가 달라 절대값 비교가 공정하지 않으므로 쓰지 않는다 — trendDeltaPercent/
   * trendShortTermChangePercent(퍼센트 변화율)를 대신 사용한다.
   */
  trendSlope: number | null;
  /** (latest - previous) / max(|previous|, minBaselineRatio) * 100. previous가 없으면 null. */
  trendDeltaPercent: number | null;
  /** (shortAverage - previousAverage) / previousAverage * 100. previousAverage가 없거나 0이면 null. */
  trendShortTermChangePercent: number | null;
  trendDirection: TrendDirection;
  /**
   * 이 cluster의 newsCount가 같은 batch(이번 run에서 나온 전체 cluster) 내에서 차지하는 percentile(0~1).
   * computeBatchPercentiles()가 채워 넣으며, aggregateClusterSignals() 직후에는 0으로 초기화되어 있다.
   */
  newsCountPercentile: number;
  /** (blogCount + webCount)의 batch 내 percentile(0~1). 위와 동일한 방식으로 채워진다. */
  contentCountPercentile: number;
  /**
   * cluster를 구성하는 항목 중 publishedAt을 제공하는 source(news/blog)가 하나라도 있었는지.
   * naver_web은 API 특성상 발행 시각을 제공하지 않으므로, web 결과로만 이루어진 cluster는 false가 된다.
   * freshness 계산에서 "정보 없음"과 "실제로 오래됨"을 구분하는 데 사용한다.
   */
  hasTimestampData: boolean;
  /** 테스트에서 시각을 고정하기 위한 override. 기본은 현재 시각(new Date()). */
  now?: Date;
};

// 점수 구성요소별 원점수(0~각 항목 만점) + 합산 total(0~100).
export type KeywordScoreBreakdown = {
  trendMomentum: number;
  newsVelocity: number;
  contentDemand: number;
  freshness: number;
  crossSourceSignal: number;
  clickPotential: number;
  total: number;
};

// runKeywordRanking()의 최종 출력 단위. n8n/Telegram 등 외부 소비자가 그대로 사용할 수 있는 형태를 목표로 한다.
// keyword_rankings 테이블에 그대로 스냅샷 저장되므로(saveRankingHistory.ts), 이 타입의 필드를 늘릴 때는
// migration/DiscoveryRun 타입도 함께 맞춰야 한다.
export type RankedKeyword = {
  rank: number;
  /** canonical keyword (짧은 대표 검색어). 포스팅/알림 등 외부 소비자가 그대로 쓰는 값. */
  keyword: string;
  /** cluster의 대표 원본 headline (축약 전 뉴스/블로그 제목). */
  headline: string;
  /** 이 결과의 trend 데이터를 조회하는 데 사용된 원래 seed 검색어. 없으면 null. */
  seedQuery: string | null;
  category: string;
  totalScore: number;
  scoreBreakdown: KeywordScoreBreakdown;
  trendDirection: TrendDirection;
  relatedCount: number;
  sources: KeywordSource[];
  latestPublishedAt: string | null;
  reason: string;
};
