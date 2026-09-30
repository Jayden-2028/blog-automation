// 에펨코리아 베스트(fmkorea.com/best) fetch 래퍼. 파싱은 parseFmkoreaHtml.ts(순수 함수)에 위임한다 -
// TheqooProvider.ts / RuliwebProvider.ts와 같은 분리다.
//
// User-Agent를 위장하지 않는다(KEYWORD_SOURCE_EXPANSION.md §5-3) - fetch의 기본 UA를 그대로 쓴다.
// 이 사이트는 robots.txt에서 AI 크롤러 40여 개를 이름으로 차단하면서도 기본 UA(`*`)에는
// `/best`, `/best2`를 명시적으로 Allow한다 - 사이트가 구분해서 열어둔 경로다. 그 구분을 UA 위장으로
// 무너뜨리지 않는다.
//
// §5-2가 우려했던 Cloudflare Bot Management는 2026-09-30/10-01 맥 실측에서 걸리지 않았다
// (HTTP 200, 74KB 정상 응답). 나중에 챌린지 페이지가 오면 파서가 0건을 반환하고
// runCommunityCollection이 그 사이트만 격리한다 - 우회 시도는 하지 않는다.

import { parseFmkoreaBestHtml } from "./parseFmkoreaHtml.js";
import type { CommunitySourceProvider } from "../CommunitySource.js";

const FMKOREA_BEST_URL = "https://www.fmkorea.com/best";
const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchFmkoreaBestHtml(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(FMKOREA_BEST_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`에펨코리아 베스트 요청 실패: HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export const fmkoreaProvider: CommunitySourceProvider = {
  site: "fmkorea",
  label: "에펨코리아 베스트",
  fetchPosts: async () => parseFmkoreaBestHtml(await fetchFmkoreaBestHtml()),
};
