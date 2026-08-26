import { NAVER_API_HUB_BASE_URL, naverPostJson } from "../naver/naverClient.js";
import { DEFAULT_NAVER_TREND_GROUPS } from "../naver/naverTrendGroups.js";

// 검색어트렌드(Search Trend) API는 뉴스/블로그/웹문서 검색과 요청/응답 구조가 전혀 다르므로
// KeywordProvider 인터페이스를 억지로 구현하지 않고 별도 타입/메서드로 다룬다.

const NAVER_SEARCH_TREND_URL = `${NAVER_API_HUB_BASE_URL}/search-trend/v1/search`;

// Search Trend API 제한: 요청 1건당 최대 5개 group, group당 최대 20개 keyword.
export const NAVER_TREND_MAX_GROUPS_PER_REQUEST = 5;
export const NAVER_TREND_MAX_KEYWORDS_PER_GROUP = 20;

export type NaverTrendTimeUnit = "date" | "week" | "month";
export type NaverTrendDevice = "pc" | "mo";
export type NaverTrendGender = "m" | "f";

export type NaverTrendKeywordGroup = {
  groupName: string;
  keywords: string[];
};

export type NaverTrendRequest = {
  /** yyyy-mm-dd */
  startDate: string;
  /** yyyy-mm-dd */
  endDate: string;
  timeUnit: NaverTrendTimeUnit;
  keywordGroups: NaverTrendKeywordGroup[];
  device?: NaverTrendDevice;
  ages?: string[];
  gender?: NaverTrendGender;
};

export type NaverTrendDataPoint = {
  period: string;
  ratio: number;
};

export type NaverTrendResult = {
  title: string;
  keywords: string[];
  data: NaverTrendDataPoint[];
};

export type NaverTrendResponse = {
  startDate: string;
  endDate: string;
  timeUnit: string;
  results: NaverTrendResult[];
};

export class NaverTrendProvider {
  async fetchTrendData(request: NaverTrendRequest): Promise<NaverTrendResponse> {
    if (request.keywordGroups.length === 0) {
      return { startDate: request.startDate, endDate: request.endDate, timeUnit: request.timeUnit, results: [] };
    }

    if (request.keywordGroups.length > NAVER_TREND_MAX_GROUPS_PER_REQUEST) {
      throw new Error(
        `NaverTrendProvider: keywordGroups는 요청당 최대 ${NAVER_TREND_MAX_GROUPS_PER_REQUEST}개까지 지원됩니다 (받은 값: ${request.keywordGroups.length}).`
      );
    }

    return naverPostJson<NaverTrendResponse>(NAVER_SEARCH_TREND_URL, request);
  }

  /** OTT/육아/생활정책/연예 등 미리 정의된 검색어 그룹(DEFAULT_NAVER_TREND_GROUPS)으로 트렌드를 조회한다. */
  async fetchDefaultGroupTrends(
    range: Pick<NaverTrendRequest, "startDate" | "endDate" | "timeUnit">
  ): Promise<NaverTrendResponse> {
    return this.fetchTrendData({
      ...range,
      keywordGroups: DEFAULT_NAVER_TREND_GROUPS,
    });
  }

  /** result.data에서 가장 최근 기간의 ratio 값을 반환한다. 데이터가 없으면 undefined. */
  static getLatestRatio(result: NaverTrendResult): number | undefined {
    return result.data[result.data.length - 1]?.ratio;
  }
}
