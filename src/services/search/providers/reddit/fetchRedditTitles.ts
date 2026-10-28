// 레딧 공개 JSON에서 최근 질문 제목을 가져온다(사용설명서 트랙 주제 수집의 보조 관찰, 2026-10-28).
//
// 인증 없는 공개 엔드포인트(`/r/<subs>/new.json`, `/r/<subs>/search.json`)다. User-Agent는 위장하지 않고
// 이 봇이 누구인지 밝힌다(스크래핑 원칙 - GoogleTrendsProvider·자동완성과 같다). 요청 간격은 호출 측이 둔다.
// 403·429는 RedditBlockedError로 던진다 - 호출 측이 그 실행에서 레딧을 통째로 건너뛴다(같은 IP로 더 두드리지 않는다).
// 그 밖의 실패는 일반 Error다(호출 측이 비치명적으로 처리한다).

export const REDDIT_BASE_URL = "https://www.reddit.com";

/** 한국 체류·여행 질문이 올라오는 서브레딧(2026-10 외부 조사: 약 19만·13만·1만 명). */
export const KSCENE_SUBREDDITS = ["koreatravel", "Living_in_Korea", "living_in_korea_now"] as const;

/** 설명적인 User-Agent. 브라우저처럼 꾸미지 않는다. */
export const REDDIT_USER_AGENT = "blog-automation-kscene/1.0 (+https://www.koreaplain.com)";

export class RedditBlockedError extends Error {
  constructor(readonly status: number) {
    super(`Reddit 차단 응답: ${status}`);
    this.name = "RedditBlockedError";
  }
}

export type FetchRedditOptions = {
  timeoutMs?: number;
  /** 테스트 주입: 네트워크 대신 JSON 본문을 돌려준다. */
  fetchJson?: (url: string) => Promise<unknown>;
};

/** 여러 서브레딧을 한 요청으로 묶는다(`/r/a+b+c/...`) - 요청 수를 서브레딧 수만큼 늘리지 않는다. */
function subredditPath(subreddits: readonly string[]): string {
  return `/r/${subreddits.join("+")}`;
}

export function buildRedditNewUrl(subreddits: readonly string[], limit = 100): string {
  return `${REDDIT_BASE_URL}${subredditPath(subreddits)}/new.json?${new URLSearchParams({ limit: String(limit), raw_json: "1" })}`;
}

export function buildRedditSearchUrl(subreddits: readonly string[], query: string, limit = 25): string {
  const params = new URLSearchParams({ q: query, restrict_sr: "1", sort: "new", limit: String(limit), raw_json: "1" });
  return `${REDDIT_BASE_URL}${subredditPath(subreddits)}/search.json?${params}`;
}

/** Listing(`{data:{children:[{data:{title}}]}}`)에서 제목만 뽑는다. 모양이 다르면 빈 배열(예외 아님). */
export function parseRedditListing(body: unknown): string[] {
  const children = (body as { data?: { children?: unknown } } | null)?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .map((child) => (child as { data?: { title?: unknown } } | null)?.data?.title)
    .filter((title): title is string => typeof title === "string" && title.trim().length > 0)
    .map((title) => title.trim());
}

async function defaultFetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": REDDIT_USER_AGENT },
    });
    if (response.status === 403 || response.status === 429) throw new RedditBlockedError(response.status);
    if (!response.ok) throw new Error(`Reddit 요청 실패: ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 한 URL(new.json 또는 search.json)의 제목 목록. */
export async function fetchRedditTitles(url: string, options: FetchRedditOptions = {}): Promise<string[]> {
  const fetchJson = options.fetchJson ?? ((u: string) => defaultFetchJson(u, options.timeoutMs ?? 10_000));
  return parseRedditListing(await fetchJson(url));
}
