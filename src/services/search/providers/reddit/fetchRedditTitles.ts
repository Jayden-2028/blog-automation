// 레딧에서 최근 질문 제목을 가져온다(사용설명서 트랙 주제 수집의 보조 관찰, 2026-10-28).
//
// 두 경로가 있다.
//   · **OAuth(app-only)** - `REDDIT_CLIENT_ID`·`REDDIT_CLIENT_SECRET`이 있으면 client_credentials로 토큰을 받아
//     `oauth.reddit.com`에 요청한다(공식 API, 분당 100회). 2026-10-28 실측에서 인증 없는 공개 JSON은 가정 IP에서도
//     첫 요청부터 403(네트워크 보안 차단 페이지)이라 실신호를 받으려면 이 경로가 필요하다.
//   · **공개 RSS** - 자격증명이 없으면 `www.reddit.com/r/<sub>/new.rss`(Atom)를 친다. 2026-10-28 실측: 공개 JSON은 403이지만
//     RSS는 200이다. 단 인증 없는 요청은 **분당 1회**(x-ratelimit-remaining 0, reset 42~60s)라 요청 간격을 61초 이상 두고,
//     요청 수도 서브레딧별 new 피드 3회로 줄인다(시드별 검색은 OAuth 모드에서만).
// URL 빌더는 www 주소를 만들고(형식은 모드에 따라 .json/.rss), 요청 직전에 OAuth 모드면 호스트만 oauth.reddit.com으로 바꾼다.
// User-Agent는 위장하지 않고 이 봇이 누구인지 밝힌다(스크래핑 원칙 - GoogleTrendsProvider·자동완성과 같다). 요청 간격은
// 호출 측이 둔다. 403·429(토큰 발급 실패 포함)는 RedditBlockedError로 던진다 - 호출 측이 그 실행에서 레딧을 통째로
// 건너뛴다(같은 IP로 더 두드리지 않는다). 그 밖의 실패는 일반 Error다(호출 측이 비치명적으로 처리한다).

export const REDDIT_BASE_URL = "https://www.reddit.com";
export const REDDIT_OAUTH_BASE_URL = "https://oauth.reddit.com";
export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
/** 인증 없는 공개 피드의 최소 요청 간격(ms). 실측 분당 1회 제한에 여유를 둔 값. */
export const REDDIT_PUBLIC_MIN_DELAY_MS = 61_000;

export type RedditFeedFormat = "json" | "rss";

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

export type RedditCredentials = { clientId: string; clientSecret: string };

/** env의 앱 자격증명. 둘 다 있어야 OAuth 모드다(하나만 있으면 설정 실수로 보고 공개 경로로 간다). */
export function redditCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): RedditCredentials | null {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** www 주소를 OAuth 호스트로 옮긴다. 경로·쿼리는 그대로(oauth.reddit.com도 `.json` 경로를 받는다). */
export function toOauthUrl(url: string): string {
  return url.startsWith(REDDIT_BASE_URL) ? `${REDDIT_OAUTH_BASE_URL}${url.slice(REDDIT_BASE_URL.length)}` : url;
}

/** client_credentials 토큰 요청의 헤더·본문(테스트가 모양을 확인한다). */
export function buildTokenRequest(credentials: RedditCredentials): { headers: Record<string, string>; body: string } {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  return {
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  };
}

// 토큰은 프로세스 안에서 캐시한다(만료 1시간 전까지). job은 실행마다 새 프로세스라 한 실행에 발급 1회다.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(credentials: RedditCredentials, timeoutMs: number): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const { headers, body } = buildTokenRequest(credentials);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(REDDIT_TOKEN_URL, { method: "POST", headers, body, signal: controller.signal });
    const json = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (response.status === 401 || response.status === 403 || response.status === 429) throw new RedditBlockedError(response.status);
    if (!response.ok || !json.access_token) throw new Error(`Reddit 토큰 발급 실패(${response.status}): ${json.error ?? ""}`.trim());
    cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  } finally {
    clearTimeout(timer);
  }
}

/** 여러 서브레딧을 한 요청으로 묶는다(`/r/a+b+c/...`) - 요청 수를 서브레딧 수만큼 늘리지 않는다. */
function subredditPath(subreddits: readonly string[]): string {
  return `/r/${subreddits.join("+")}`;
}

export function buildRedditNewUrl(subreddits: readonly string[], limit = 100, format: RedditFeedFormat = "json"): string {
  return `${REDDIT_BASE_URL}${subredditPath(subreddits)}/new.${format}?${new URLSearchParams({ limit: String(limit), raw_json: "1" })}`;
}

export function buildRedditSearchUrl(subreddits: readonly string[], query: string, limit = 25, format: RedditFeedFormat = "json"): string {
  const params = new URLSearchParams({ q: query, restrict_sr: "1", sort: "new", limit: String(limit), raw_json: "1" });
  return `${REDDIT_BASE_URL}${subredditPath(subreddits)}/search.${format}?${params}`;
}

/** Atom 피드(`<entry><title>…</title>`)에서 제목만 뽑는다. 피드 자체 제목(`<feed><title>`)은 entry 밖이라 안 잡힌다. */
export function parseRedditAtom(xml: string): string[] {
  const titles: string[] = [];
  for (const entry of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const match = /<title>([\s\S]*?)<\/title>/.exec(entry[1]);
    if (!match) continue;
    const title = match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .trim();
    if (title) titles.push(title);
  }
  return titles;
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
  const credentials = redditCredentialsFromEnv();
  const headers: Record<string, string> = { Accept: isRssUrl(url) ? "application/atom+xml, application/rss+xml, application/xml" : "application/json", "User-Agent": REDDIT_USER_AGENT };
  let target = url;
  if (credentials) {
    headers.Authorization = `Bearer ${await getAccessToken(credentials, timeoutMs)}`;
    target = toOauthUrl(url);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { signal: controller.signal, headers });
    if (response.status === 403 || response.status === 429) throw new RedditBlockedError(response.status);
    if (!response.ok) throw new Error(`Reddit 요청 실패: ${response.status} ${response.statusText}`);
    return isRssUrl(target) ? await response.text() : await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function isRssUrl(url: string): boolean {
  return /\.rss(\?|$)/.test(url);
}

/** 한 URL(new/search의 .json 또는 .rss)의 제목 목록. */
export async function fetchRedditTitles(url: string, options: FetchRedditOptions = {}): Promise<string[]> {
  const fetchJson = options.fetchJson ?? ((u: string) => defaultFetchJson(u, options.timeoutMs ?? 10_000));
  const body = await fetchJson(url);
  return isRssUrl(url) && typeof body === "string" ? parseRedditAtom(body) : parseRedditListing(body);
}
