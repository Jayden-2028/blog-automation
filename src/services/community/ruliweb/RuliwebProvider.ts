// 루리웹 베스트(bbs.ruliweb.com/best) fetch 래퍼. 파싱은 parseRuliwebHtml.ts(순수 함수)에 위임한다 -
// TheqooProvider.ts/parseTheqooHtml.ts와 같은 분리다.
//
// User-Agent를 위장하지 않는다(KEYWORD_SOURCE_EXPANSION.md §5-3) - fetch의 기본 UA를 그대로 쓴다.
// robots.txt는 이미 실측 확인했다(2026-09-30, `User-agent: *`에 /best를 막는 규칙 없음) -
// 매 호출마다 다시 조회하지 않는다. 재확인은 scripts/communityRecon.ts를 다시 돌리면 된다.

import { parseRuliwebBestHtml } from "./parseRuliwebHtml.js";
import type { CommunitySourceProvider } from "../CommunitySource.js";

const RULIWEB_BEST_URL = "https://bbs.ruliweb.com/best";
const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchRuliwebBestHtml(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RULIWEB_BEST_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`루리웹 베스트 요청 실패: HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export const ruliwebProvider: CommunitySourceProvider = {
  site: "ruliweb",
  label: "루리웹 베스트",
  fetchPosts: async () => parseRuliwebBestHtml(await fetchRuliwebBestHtml()),
};
