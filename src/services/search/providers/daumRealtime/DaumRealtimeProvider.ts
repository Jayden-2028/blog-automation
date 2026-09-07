// 다음(Daum) 홈 "실시간 트렌드" 위젯을 가져오는 provider.
//
// GoogleTrendsProvider.ts와 같은 층위: 브라우저/로그인/persistent profile이 필요 없다. 인증 없는
// 공개 페이지를 정직한 User-Agent로 그냥 GET한다(스크래핑 운영 원칙 - UA를 위장하지 않는다).
// 파싱은 parseDaumRealtimePage.ts(순수 함수)가 담당하고, 이 파일은 네트워크 호출과 실패 표면만 맡는다.

import { parseDaumRealtimePage, type DaumRealtimeItem } from "./parseDaumRealtimePage.js";

export const DAUM_HOMEPAGE_URL = "https://www.daum.net/";

export type FetchDaumRealtimeOptions = {
  /** 요청 타임아웃(ms). 기본 15초. */
  timeoutMs?: number;
  /** 테스트에서 네트워크 대신 페이지 HTML을 직접 주입하는 지점. */
  fetchHtml?: (url: string) => Promise<string>;
};

export type FetchDaumRealtimeResult = {
  items: DaumRealtimeItem[];
  /** 위젯에 표시된 갱신 시각(다음이 준 값 그대로). */
  updatedAt?: string;
  /** 실제로 호출한 URL(진단용). */
  requestUrl: string;
  /** 수집 시각 ISO. trend_date/expires_at 산출의 기준이 된다. */
  collectedAt: string;
};

async function defaultFetchHtml(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`다음 홈 요청 실패: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 다음 실시간 트렌드를 1회 가져온다. 네트워크/HTTP 실패는 예외로 던진다 - 비치명적 처리는
 * 호출자(runDaumRealtimeCollection)가 한다. 페이지 구조가 바뀌어 위젯을 못 찾으면 예외 없이
 * items: []를 반환한다(parseDaumRealtimePage.ts 원칙).
 */
export async function fetchDaumRealtime(
  options: FetchDaumRealtimeOptions = {}
): Promise<FetchDaumRealtimeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchHtml = options.fetchHtml ?? ((url: string) => defaultFetchHtml(url, timeoutMs));

  const html = await fetchHtml(DAUM_HOMEPAGE_URL);
  const { items, updatedAt } = parseDaumRealtimePage(html);

  return {
    items,
    updatedAt,
    requestUrl: DAUM_HOMEPAGE_URL,
    collectedAt: new Date().toISOString(),
  };
}
