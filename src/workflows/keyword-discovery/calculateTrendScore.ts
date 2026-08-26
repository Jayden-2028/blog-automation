// 뉴스/블로그/웹문서 결과 수 + 검색어트렌드 최근 값을 조합해 0~100 사이의 trend score를 계산한다.
// 기존 NaverNewsKeywordProvider의 "검색 결과 내 순위" 기반 trendScore 방식은 그대로 유지하고,
// 이 계산기는 runNaverKeywordDiscovery 같은 다중 소스 orchestration에서 별도로 사용한다.

export type TrendScoreInput = {
  newsCount: number;
  blogCount: number;
  webCount: number;
  /** 검색어트렌드(DataLab) 최근 기간의 ratio 값 (0~100). 조회 실패/데이터 없음이면 생략. */
  trendRatio?: number;
};

// 각 요소가 최종 점수에 반영되는 비중. 합이 1이 되도록 유지한다.
export const TREND_SCORE_WEIGHTS = {
  news: 0.3,
  blog: 0.25,
  web: 0.15,
  trend: 0.3,
} as const;

// 결과 수를 0~100 스케일로 정규화할 때 기준으로 삼는 상한값.
// 이 값 이상의 결과 수는 모두 100점으로 취급한다.
const COUNT_NORMALIZATION_CAP = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeCount(count: number): number {
  return clamp((count / COUNT_NORMALIZATION_CAP) * 100, 0, 100);
}

export function calculateTrendScore(input: TrendScoreInput): number {
  const newsScore = normalizeCount(input.newsCount);
  const blogScore = normalizeCount(input.blogCount);
  const webScore = normalizeCount(input.webCount);
  const trendScore = clamp(input.trendRatio ?? 0, 0, 100);

  const total =
    newsScore * TREND_SCORE_WEIGHTS.news +
    blogScore * TREND_SCORE_WEIGHTS.blog +
    webScore * TREND_SCORE_WEIGHTS.web +
    trendScore * TREND_SCORE_WEIGHTS.trend;

  return Math.round(clamp(total, 0, 100));
}
