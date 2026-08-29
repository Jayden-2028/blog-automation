// 구글 트렌드 "Trending now" RSS를 가져오는 provider.
//
// Creator Advisor(BrowserCreatorAdvisorProvider)와 달리 브라우저/로그인/persistent profile이 전혀
// 필요 없다. 인증도 없다. 그래서 클라우드 이전(docs/ai-handoff/CLOUD_MIGRATION.md)에도 이 소스는
// 제약이 되지 않는다 - Creator Advisor가 로그인 프로필에 묶여 있는 것과 대조된다.
//
// 파싱은 parseGoogleTrendsRss.ts(순수 함수)가 담당하고, 이 파일은 네트워크 호출과 실패 표면만 맡는다.

import { parseGoogleTrendsRss, type GoogleTrendsItem } from "./parseGoogleTrendsRss.js";

/**
 * 신 엔드포인트. 구 `/trends/trendingsearches/daily/rss?geo=KR`은 폐기됐다.
 * ⚠️ 이 세션에서는 외부 egress 차단으로 실측하지 못했다 - 맥에서 먼저 dry-run으로 확인할 것.
 */
export const GOOGLE_TRENDS_RSS_URL = "https://trends.google.com/trending/rss";

export type FetchGoogleTrendsOptions = {
  /** 국가 코드. 기본 KR. */
  geo?: string;
  /** 요청 타임아웃(ms). 기본 15초 - daily job 전체 예산(약 100초) 대비 충분히 작게 잡는다. */
  timeoutMs?: number;
  /** 테스트에서 네트워크 대신 RSS 본문을 직접 주입하는 지점. */
  fetchRss?: (url: string) => Promise<string>;
};

export type FetchGoogleTrendsResult = {
  items: GoogleTrendsItem[];
  /** 실제로 호출한 URL(진단용). */
  requestUrl: string;
  /** 수집 시각 ISO. trend_date/collected_at 산출의 기준이 된다. */
  collectedAt: string;
};

async function defaultFetchRss(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // User-Agent를 위장하지 않는다. 공개 피드를 정직하게 읽는다는 원칙(스크래핑 운영 원칙)에
        // 맞추고, 차단당하면 차단당한 대로 실패를 드러내는 편이 조용한 오작동보다 낫다.
        Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Google Trends RSS 요청 실패: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 급상승 검색어를 1회 가져온다. 피드 순서를 그대로 유지하므로 배열 index가 곧 순위다.
 * 네트워크/HTTP 실패는 예외로 던진다 - 비치명적 처리는 호출자(runGoogleTrendsCollection)가 한다.
 */
export async function fetchGoogleTrends(
  options: FetchGoogleTrendsOptions = {}
): Promise<FetchGoogleTrendsResult> {
  const geo = options.geo ?? "KR";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requestUrl = `${GOOGLE_TRENDS_RSS_URL}?geo=${encodeURIComponent(geo)}`;

  const fetchRss = options.fetchRss ?? ((url: string) => defaultFetchRss(url, timeoutMs));
  const xml = await fetchRss(requestUrl);

  return {
    items: parseGoogleTrendsRss(xml),
    requestUrl,
    collectedAt: new Date().toISOString(),
  };
}
