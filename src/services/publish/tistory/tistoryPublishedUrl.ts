// 티스토리 발행 글의 **실제 주소**를 찾는 도구들(2026-10-27). 발행기(TistoryPublisher)와 교정 CLI(tistoryUrlAuditCli)가
// 같이 쓴다 - Playwright를 import하지 않아 CLI에서 브라우저 없이 쓸 수 있다.
//
// 왜 따로 찾아야 하나(2026-10-27 실측, 발행 기록 101건 중 18건이 404):
//   1. 발행 레이어의 슬러그(input#urlPublish)는 **발행 시 티스토리가 다듬는다** - 쉼표·물음표·느낌표·작은따옴표·퍼센트를
//      지운다(`2,000명`→`2000명`, `발견,-혐의`→`발견-혐의`, `30%`→`30`). 가운뎃점 `·`과 한자는 남는다.
//   2. RSS는 `·`을 `&amp;middot;`로 **두 번** 이스케이프한다. 옛 decodeEntities는 `&middot;`를 `&amp;`보다 먼저 풀어
//      `·`이 든 제목을 영원히 못 찾았다.
// 순수 함수 테스트: testTistoryPublishedUrl.ts

export type TistoryUrlSource = "page-url" | "manage-list" | "rss" | "search" | "slug-verified" | "slug-unverified";

const NAMED_ENTITIES: Record<string, string> = {
  middot: "·",
  nbsp: " ",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
};

/** HTML/XML 엔티티를 푼다. `&amp;`를 **먼저**(두 번 중첩까지) 풀어야 `&amp;middot;` 같은 이중 이스케이프가 풀린다. */
export function decodeEntities(text: string): string {
  let out = text.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1");
  for (let i = 0; i < 2 && out.includes("&amp;"); i += 1) out = out.replace(/&amp;/g, "&");
  return out
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** 비교용 정규화 - 특수문자는 엔티티·다듬기로 흔들리므로 한글·영숫자만 남긴다(캡션 검증과 같은 이유). */
export function normalizeTitle(text: string): string {
  return decodeEntities(text).replace(/[^0-9A-Za-z가-힣]/g, "");
}

/** RSS XML에서 제목이 같은 item의 link. 같은 제목이 여럿이면 최신(첫 번째) 것. */
export function matchRssLink(rssXml: string, title: string): string | null {
  const want = normalizeTitle(title);
  if (!want) return null;
  for (const match of rssXml.matchAll(/<item>.*?<title>(.*?)<\/title>.*?<link>(.*?)<\/link>/gs)) {
    if (normalizeTitle(match[1]) === want) return decodeEntities(match[2]).trim();
  }
  return null;
}

/**
 * 티스토리가 발행 때 슬러그를 다듬는 규칙을 흉내 낸다. 입력은 슬러그(하이픈 구분)든 제목(공백 구분)이든 된다.
 * 실측으로 확인한 제거 문자는 , ? ! ' % 이고, 같은 계열(큰따옴표·콜론·세미콜론·괄호·둥근 따옴표)도 지운다.
 * `·`·한자·영숫자는 남긴다. 추정일 뿐이라 쓰기 전에 HEAD로 확인한다(slug-verified).
 */
export function sanitizeTistorySlug(slugOrTitle: string): string {
  return slugOrTitle
    .normalize("NFC")
    .replace(/[,?!'"%:;()‘’“”]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function tistoryEntryUrl(blogName: string, slug: string): string {
  return `https://${blogName}.tistory.com/entry/${encodeURIComponent(slug)}`;
}

/** 저장된 주소에서 슬러그를 꺼낸다(퍼센트 인코딩을 푼다). `?`가 인코딩되지 않고 들어간 옛 주소도 그대로 슬러그로 본다. */
export function slugFromEntryUrl(url: string): string | null {
  const match = url.match(/\/entry\/(.+)$/);
  if (!match) return null;
  const raw = match[1].replace(/#.*$/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // `30%`처럼 인코딩 안 된 퍼센트가 섞이면 실패한다 - 풀 수 있는 조각만 푼다.
    return raw.replace(/(%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

/** 발행 직후 브라우저가 머문 주소가 공개 글 주소(`/entry/…` 또는 `/<숫자>`)인가. 관리 화면 주소는 아니다. */
export function isTistoryPostUrl(url: string, blogName: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== `${blogName}.tistory.com`) return false;
  return /^\/entry\/[^/]+\/?$/.test(parsed.pathname) || /^\/\d+\/?$/.test(parsed.pathname);
}

/** 블로그 검색 결과 HTML에서 제목이 같은 글의 `/entry/` 주소(첫 번째). 스킨마다 다르니 제목 후보를 넓게 본다. */
export function matchSearchLink(html: string, title: string, blogName: string): string | null {
  const want = normalizeTitle(title);
  if (!want) return null;
  const hrefRe = /href="((?:https?:\/\/[^"/]+)?\/entry\/[^"#?]+)"/g;
  const hits = [...html.matchAll(hrefRe)];
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index ?? 0;
    const end = hits[i + 1]?.index ?? Math.min(html.length, start + 5000);
    const chunk = html.slice(start, end);
    const titles = [
      ...[...chunk.matchAll(/data-tiara-(?:name|copy)="([^"]*)"/g)].map((m) => m[1]),
      ...[...chunk.matchAll(/class="[^"]*(?:txt_title|title)[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]),
    ];
    if (titles.some((t) => normalizeTitle(t) === want)) {
      const path = hits[i][1].replace(/^https?:\/\/[^/]+/, "");
      return `https://${blogName}.tistory.com${path}`;
    }
  }
  return null;
}

/** 검색어 - 제목 앞 4단어(특수문자 제거). 티스토리 검색은 경로에 그대로 넣는다. */
export function searchQueryFor(title: string): string {
  const words = decodeEntities(title)
    .replace(/[^\p{L}\p{N}\s·]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 4).join(" ");
}

// ---------- 네트워크(읽기 전용) ----------

export type FetchLike = (url: string, init?: { method?: string; redirect?: "follow" | "manual" }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export type HeadCheck = (url: string) => Promise<number>;

const defaultFetch: FetchLike = (url, init) => fetch(url, { ...init, headers: { "user-agent": "Mozilla/5.0 (blog-automation url-check)" } });

export const fetchHeadStatus: HeadCheck = async (url) => {
  try {
    return (await defaultFetch(url, { method: "HEAD", redirect: "follow" })).status;
  } catch {
    return 0;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 발행 직후 RSS 반영이 늦을 수 있어 지수 백오프로 재시도한다(대기 합 60초). */
export const RSS_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export async function resolveUrlFromRss(
  blogName: string,
  title: string,
  options: { delaysMs?: readonly number[]; fetchImpl?: FetchLike; wait?: (ms: number) => Promise<unknown> } = {}
): Promise<string | null> {
  const delays = options.delaysMs ?? RSS_RETRY_DELAYS_MS;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const wait = options.wait ?? sleep;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const res = await fetchImpl(`https://${blogName}.tistory.com/rss`);
      if (res.ok) {
        const link = matchRssLink(await res.text(), title);
        if (link) return link;
      }
    } catch {
      // 네트워크 실패는 재시도로
    }
    if (attempt < delays.length) await wait(delays[attempt]);
  }
  return null;
}

export async function resolveUrlFromSearch(blogName: string, title: string, fetchImpl: FetchLike = defaultFetch): Promise<string | null> {
  const query = searchQueryFor(title);
  if (!query) return null;
  try {
    const res = await fetchImpl(`https://${blogName}.tistory.com/search/${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    return matchSearchLink(await res.text(), title, blogName);
  } catch {
    return null;
  }
}

/** 슬러그(또는 제목)를 다듬어 추정 주소를 만들고 HEAD 200이면 verified. */
export async function resolveUrlFromSlug(
  blogName: string,
  slugOrTitle: string,
  headStatus: HeadCheck = fetchHeadStatus
): Promise<{ url: string; verified: boolean } | null> {
  const slug = sanitizeTistorySlug(slugOrTitle);
  if (!slug) return null;
  const url = tistoryEntryUrl(blogName, slug);
  return { url, verified: (await headStatus(url)) === 200 };
}

/** 글 페이지 HTML의 canonical(없으면 og:url). `/<숫자>` 주소를 `/entry/` 주소로 바꿀 때 쓴다. */
export function extractCanonicalUrl(html: string): string | null {
  const canonical =
    html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1] ??
    html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i)?.[1] ??
    html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)?.[1];
  if (!canonical) return null;
  // 스킨에 따라 한글을 인코딩하지 않고 싣는다(2026-10-27 /120 실측) - 저장 주소 형식을 맞추려 퍼센트 인코딩으로 통일한다.
  try {
    return new URL(decodeEntities(canonical)).href;
  } catch {
    return null;
  }
}
