// query별 검색어트렌드(DataLab) 최근 구간 데이터를 조회해 momentum(단기 delta + 중기 추세)을 계산한다.
// 단순 "최신값 - 직전값" 하나만 보면 DataLab 일별 ratio의 하루짜리 노이즈에 momentum 판정이 휘둘리므로
// (예: 실제로는 상승 추세인데 어제 하루만 살짝 내려간 경우), 최근 3구간 평균 / 그 이전 3구간 평균 /
// 최근 구간 선형회귀 기울기(slope)까지 함께 계산해 scoreKeyword()가 단기+중기 신호를 함께 반영할 수 있게 한다.

import {
  NAVER_TREND_MAX_GROUPS_PER_REQUEST,
  NaverTrendProvider,
  type NaverTrendDataPoint,
  type NaverTrendTimeUnit,
} from "../../services/search/providers/NaverTrendProvider.js";

export type TrendMomentum = {
  /** 조회된 구간 중 최근 값들(최대 7개, 오래된 순 -> 최신 순). 디버그/로깅용. */
  recentValues: number[];
  latestRatio: number;
  /** 비교 가능한 직전 기간 데이터가 없으면(예: 조회 기간이 하루뿐) null. */
  previousRatio: number | null;
  /** 최근 3개 구간 평균. 데이터가 1개뿐이면 그 값, 0개면 null(발생하지 않음 - latestRatio 존재가 전제). */
  shortAverage: number | null;
  /** 그 이전 3개 구간(최근 3개 바로 앞) 평균. 비교할 만한 구간이 없으면 null. */
  previousAverage: number | null;
  /** 최근 구간(최대 7포인트) 선형회귀 기울기(ratio/일). 포인트가 3개 미만이면 null. */
  slope: number | null;
  /** (shortAverage - previousAverage) / previousAverage * 100. previousAverage가 없거나 0이면 null. */
  shortTermChangePercent: number | null;
};

export type FetchTrendMomentumOptions = {
  /** 조회 기간(일). 중기 추세 계산을 위해 최소 7 이상 권장. 기본 14일. */
  rangeDays?: number;
  timeUnit?: NaverTrendTimeUnit;
};

export type FetchTrendMomentumResult = {
  momentumByQuery: Map<string, TrendMomentum>;
  succeeded: boolean;
  error?: string;
};

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// 최근 구간(최대 7포인트)에 대한 단순 최소자승 선형회귀 기울기. x=0..n-1(일 단위 index), y=ratio.
// 포인트가 3개 미만이면 노이즈만 반영하게 되므로 null 처리한다.
function computeSlope(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;

  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, i) => sum + x * values[i], 0);
  const sumXX = xs.reduce((sum, x) => sum + x * x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  return (n * sumXY - sumX * sumY) / denominator;
}

export function computeTrendMomentum(data: NaverTrendDataPoint[]): TrendMomentum | null {
  if (data.length === 0) return null;

  const ratios = data.map((point) => point.ratio);
  const latestRatio = ratios[ratios.length - 1];
  const previousRatio = ratios.length >= 2 ? ratios[ratios.length - 2] : null;

  const recentWindow = ratios.slice(-7);
  const shortWindow = ratios.slice(-3);
  const previousWindow = ratios.slice(Math.max(0, ratios.length - 6), Math.max(0, ratios.length - 3));

  const shortAverage = average(shortWindow);
  const previousAverage = average(previousWindow);
  const slope = computeSlope(recentWindow);

  const shortTermChangePercent =
    shortAverage !== null && previousAverage !== null && previousAverage !== 0
      ? ((shortAverage - previousAverage) / previousAverage) * 100
      : null;

  return {
    recentValues: recentWindow,
    latestRatio,
    previousRatio,
    shortAverage,
    previousAverage,
    slope,
    shortTermChangePercent,
  };
}

export async function fetchTrendMomentumByQuery(
  queries: string[],
  options: FetchTrendMomentumOptions = {}
): Promise<FetchTrendMomentumResult> {
  const momentumByQuery = new Map<string, TrendMomentum>();
  if (queries.length === 0) {
    return { momentumByQuery, succeeded: false };
  }

  const trendProvider = new NaverTrendProvider();
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - (options.rangeDays ?? 14) * 24 * 60 * 60 * 1000);
  const timeUnit = options.timeUnit ?? "date";

  let succeeded = false;
  let lastError: string | undefined;

  // DataLab API는 요청당 최대 5개 groupName까지만 허용하므로 query를 batch로 나눠 순차 호출한다.
  for (let i = 0; i < queries.length; i += NAVER_TREND_MAX_GROUPS_PER_REQUEST) {
    const batch = queries.slice(i, i + NAVER_TREND_MAX_GROUPS_PER_REQUEST);

    try {
      const response = await trendProvider.fetchTrendData({
        startDate: toDateString(startDate),
        endDate: toDateString(endDate),
        timeUnit,
        keywordGroups: batch.map((query) => ({ groupName: query, keywords: [query] })),
      });
      succeeded = true;

      for (const result of response.results) {
        const momentum = computeTrendMomentum(result.data);
        if (!momentum) continue;
        momentumByQuery.set(result.title, momentum);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error("⚠️ trend momentum 조회 실패 -", lastError);
    }
  }

  return { momentumByQuery, succeeded, error: lastError };
}
