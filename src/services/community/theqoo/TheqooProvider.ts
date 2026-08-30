// 더쿠 핫게시판(theqoo.net/hot) fetch 래퍼. 파싱은 parseTheqooHtml.ts(순수 함수)에 위임한다 -
// GoogleTrendsProvider.ts/parseGoogleTrendsRss.ts와 같은 분리다.
//
// User-Agent를 위장하지 않는다(KEYWORD_SOURCE_EXPANSION.md §5-3) - fetch의 기본 UA를 그대로 쓴다.
// robots.txt는 이미 실측 확인했다(2026-08-30, disallow 없음) - 매 호출마다 다시 조회하지 않는다.
// robots.txt 정책이 나중에 바뀔 수 있으니, 이 상태를 재확인하고 싶으면 scripts/communityRecon.ts를
// 다시 돌리면 된다.

import { parseTheqooHotHtml } from "./parseTheqooHtml.js";
import type { CommunitySourceProvider } from "../CommunitySource.js";

const THEQOO_HOT_URL = "https://theqoo.net/hot";
const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchTheqooHotHtml(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(THEQOO_HOT_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`더쿠 핫게시판 요청 실패: HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export const theqooProvider: CommunitySourceProvider = {
  site: "theqoo",
  label: "더쿠 핫게시판",
  fetchPosts: async () => parseTheqooHotHtml(await fetchTheqooHotHtml()),
};
