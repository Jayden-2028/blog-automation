// Korea Plain(사용설명서 트랙, Blogger) 글의 내부 구조 보강(2026-10-27).
// TKM = Korea Plain(구 The Korea Manual, 2026-10-28 리브랜딩). 식별자·파일명·환경변수의 TKM/kscene은 운영 영향 때문에 그대로 둔다.
//
// 왜 필요한가: 개설 20일·38편인데 구글 색인 0건. robots·noindex·canonical·사이트맵은 정상이고, URL 검사는 전부
// "발견됨 - 현재 색인 생성되지 않음"이었다. 실측해 보니 크롤러가 홈에서 글로 흘러갈 길이 거의 없었다.
//  - 본문에 다른 TKM 글로 가는 링크가 0개였다. 영어본은 prepareManuscript의 "배리에이션 재사용" 경로를 타서
//    appendRelatedPosts(한글 원고용)를 거치지 않는다.
//  - robots.txt가 Blogger 기본값 `Disallow: /search`라 홈의 "Older posts"·라벨 페이지·아카이브 다음 페이지가
//    전부 크롤 차단이다. 홈·월 아카이브는 최신 12~14편까지만 링크한다 - 그보다 오래된 글은 사이트맵 말고 길이 없다.
//  - 소제목이 `<p><strong>`이라 실제 `<h2>`가 없었다(테마 위젯 제목 1개뿐).
//
// 그래서 글마다 세 가지를 넣는다. 전부 결정론적이다(LLM이 주소를 지어내지 않는다 - 목록은 Blogger API에서 읽는다).
//  1) 소제목 `<h2>`  2) "Related Guides" 블록 - 비슷한 글 3개 + **바로 이전 글**(체인) + **All Guides 페이지**(허브)
//  3) BlogPosting JSON-LD(본문 안 `<script>`, Blogger가 보존함을 2026-10-27 실험으로 확인 - TKM_JSONLD_IN_BODY)
// 체인: 글 N은 글 N-1을 가리키고 최신 글은 홈에 있으니 모든 글이 홈에서 이어진다. 허브: All Guides 한 페이지가
// 전 글을 링크해 어느 글이든 2클릭이다. 둘 중 하나가 깨져도 다른 길이 남는다.
//
// 블록은 `class="tkm-related"` div와 `class="tkm-jsonld"` script로 감싸 **다시 돌려도 갈아 끼운다**(멱등).
// 도메인은 하드코딩하지 않는다 - 링크 주소는 Blogger가 돌려준 글 URL에서, 사이트 루트는 그 origin에서 얻는다.

/**
 * 본문 안 BlogPosting JSON-LD를 넣을지. 2026-10-27 실험: posts.patch로 넣은 `<script type="application/ld+json">`을
 * Blogger가 저장·공개 페이지 양쪽에서 그대로 보존했다(1편 확인 후 38편 적용, 38/38 보존). 테마 수정 없이 본문으로 간다.
 */
export const TKM_JSONLD_IN_BODY = true;

/** 허브 페이지 제목. Blogger는 페이지 URL을 제목에서 만든다 -> /p/all-guides.html. */
export const TKM_ALL_GUIDES_TITLE = "All Guides";
export const TKM_ALL_GUIDES_PATH = "/p/all-guides.html";
/** 저자·발행자 이름(JSON-LD). 블로그 이름과 같다. */
export const TKM_BRAND_NAME = "Korea Plain";
/**
 * 태그라인. "plain"이 "평원·단순한"으로 읽히지 않게 이름 옆에 늘 붙인다 - 블로그 제목 옆(테마, UI 작업)·About·메타 설명·
 * JSON-LD(publisher.slogan)에 노출한다.
 */
export const TKM_BRAND_TAGLINE = "Korea, in plain English";
/** 블로그 설명·메타 설명·JSON-LD publisher.description. */
export const TKM_BRAND_DESCRIPTION = "Practical step-by-step guides to Korean transport, apps, errands, and customs — in plain English.";
/** 2026-10-28까지의 이름. 같은 이름의 제3자 사이트(thekoreamanual.com)와 충돌해 바꿨다. 기존 글·페이지 치환에만 쓴다. */
export const TKM_FORMER_BRAND_NAME = "The Korea Manual";

const RELATED_CLASS = "tkm-related";
const JSONLD_CLASS = "tkm-jsonld";
/** renderPublishBlocks.ts와 같은 값(본문 15px, 소제목 19px, 빈 문단 간격). */
const BODY_STYLE = "font-size:15px";
const HEADING_STYLE = "font-size:19px";
const SPACER_HTML = "<p>&nbsp;</p>";

/** 비슷한 글 몇 개를 붙일지(이전 글·All Guides 링크는 별도). */
export const TKM_SIMILAR_LINKS = 3;

export type TkmPost = { url: string; title: string; labels: string[]; published: string };
export type TkmLink = { url: string; title: string };
export type TkmRelated = { similar: TkmLink[]; previous: TkmLink | null; allGuidesUrl: string | null };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 비교용 주소: 쿼리·해시·m=1 차이를 무시한다. */
export function normalizePostUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function siteOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from get guide how in into is it its of on or the to vs what when where which who why with you your korea korean 2026".split(" ")
);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .map((token) => token.replace(/s$/, ""))
      .filter((token) => token.length > 2 && !STOPWORDS.has(token))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 같은 라벨이면 얹어 주는 점수. 제목이 하나도 안 겹쳐도 같은 주제 묶음끼리 먼저 이어진다. */
const SAME_LABEL_BONUS = 0.15;

/**
 * 이 글에 붙일 링크를 고른다.
 *  - previous: 이 글보다 먼저 발행된 글 중 가장 최근 것(체인). 새 글이면 지금 가장 최신 글이다.
 *  - similar: 제목 토큰 Jaccard + 같은 라벨 가산점 상위 N개(이전 글과 겹치지 않게). 모자라면 최신순으로 채운다.
 */
export function pickTkmRelated(
  self: { url: string | null; title: string; labels: string[]; published: string | null },
  posts: readonly TkmPost[],
  allGuidesUrl: string | null,
  limit = TKM_SIMILAR_LINKS
): TkmRelated {
  const selfKey = self.url ? normalizePostUrl(self.url) : null;
  const others = posts
    .filter((post) => post.url && post.title && normalizePostUrl(post.url) !== selfKey)
    .sort((a, b) => b.published.localeCompare(a.published));

  const selfTime = self.published ?? "9999";
  const previousPost = others.find((post) => post.published < selfTime) ?? null;

  const selfTokens = titleTokens(self.title);
  const scored = others
    .filter((post) => post !== previousPost)
    .map((post) => ({
      post,
      score: jaccard(selfTokens, titleTokens(post.title)) + (post.labels.some((label) => self.labels.includes(label)) ? SAME_LABEL_BONUS : 0),
    }))
    .sort((a, b) => b.score - a.score || b.post.published.localeCompare(a.post.published));
  const similar = scored.filter((entry) => entry.score > 0).slice(0, limit).map((entry) => entry.post);
  for (const post of others) {
    if (similar.length >= limit) break;
    if (post !== previousPost && !similar.includes(post)) similar.push(post);
  }

  const toLink = (post: TkmPost): TkmLink => ({ url: post.url, title: post.title });
  return { similar: similar.map(toLink), previous: previousPost ? toLink(previousPost) : null, allGuidesUrl };
}

/**
 * Related 블록 HTML. 링크가 하나도 없으면 빈 문자열. 간격 문단은 **div 안에** 둔다(`spacer`) - 밖에 두면 다시 돌릴 때
 * 걷히지 않고 쌓인다. References 앞에 끼울 때는 뒤에(앞에는 이미 간격이 있다), 글 끝에 붙일 때는 앞에 둔다.
 */
export function buildRelatedHtml(related: TkmRelated, spacer: "before" | "after" = "after"): string {
  const items = related.similar.map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a></li>`);
  const footer: string[] = [];
  if (related.previous) {
    footer.push(`Previous guide: <a href="${escapeHtml(related.previous.url)}">${escapeHtml(related.previous.title)}</a>`);
  }
  if (related.allGuidesUrl) {
    footer.push(`Browse every guide by topic: <a href="${escapeHtml(related.allGuidesUrl)}">${TKM_ALL_GUIDES_TITLE}</a>`);
  }
  if (items.length === 0 && footer.length === 0) return "";
  return [
    `<div class="${RELATED_CLASS}">`,
    ...(spacer === "before" ? [SPACER_HTML] : []),
    `<h2 style="${HEADING_STYLE}">Related Guides</h2>`,
    ...(items.length > 0 ? [`<ul style="${BODY_STYLE}">${items.join("")}</ul>`] : []),
    ...(footer.length > 0 ? [`<p style="${BODY_STYLE}">${footer.join("<br>")}</p>`] : []),
    ...(spacer === "after" ? [SPACER_HTML] : []),
    `</div>`,
  ].join("\n");
}

export type TkmJsonLdInput = {
  url: string;
  headline: string;
  description: string;
  datePublished: string;
  dateModified: string;
  imageUrl: string | null;
};

/** JSON-LD 저자·발행자. 발행자에만 태그라인(slogan)과 설명을 싣는다 - 저자까지 실으면 글마다 같은 문장이 두 번 들어간다. */
export function tkmJsonLdBrand(origin: string | null): { author: Record<string, string>; publisher: Record<string, string> } {
  const url: Record<string, string> = origin ? { url: `${origin}/` } : {};
  return {
    author: { "@type": "Organization", name: TKM_BRAND_NAME, ...url },
    publisher: { "@type": "Organization", name: TKM_BRAND_NAME, slogan: TKM_BRAND_TAGLINE, description: TKM_BRAND_DESCRIPTION, ...url },
  };
}

/**
 * script 안에 넣을 JSON. `<`는 script가 일찍 닫히지 않게, **ASCII 밖 글자는 전부 `\uXXXX`로** 쓴다 - Blogger가 본문을 내보낼 때
 * script 안의 비ASCII도 `&#8212;` 같은 엔티티로 바꾸는데, script 안 엔티티는 해석되지 않아 구조화 데이터에 그대로 남는다
 * (2026-10-28 실측: "—"가 공개 페이지에서 "&#8212;", 기존 글의 "–"·"₩"도 같은 증상). JSON 이스케이프는 파서가 원래 글자로 읽는다.
 */
export function jsonLdForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** BlogPosting JSON-LD `<script>`. `<`를 이스케이프해 본문 HTML 안에서 script가 일찍 닫히지 않게 한다. */
export function buildJsonLdHtml(input: TkmJsonLdInput): string {
  const { author, publisher } = tkmJsonLdBrand(siteOrigin(input.url));
  const data = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.headline.slice(0, 110),
    description: input.description,
    datePublished: input.datePublished,
    dateModified: input.dateModified,
    author,
    publisher,
    ...(input.imageUrl ? { image: [input.imageUrl] } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    url: input.url,
  };
  return `<script type="application/ld+json" class="${JSONLD_CLASS}">${jsonLdForScript(data)}</script>`;
}

// 뒤 줄바꿈까지 먹는 쪽을 먼저 시도한다(References 앞에 끼운 경우). 글 끝에 붙인 경우는 앞 줄바꿈을 먹는다.
const RELATED_BLOCK_RE = new RegExp(String.raw`<div\b[^>]*\b${RELATED_CLASS}\b[^>]*>[\s\S]*?</div>\n|\n?<div\b[^>]*\b${RELATED_CLASS}\b[^>]*>[\s\S]*?</div>`, "gi");
const JSONLD_BLOCK_RE = new RegExp(String.raw`\n?<script\b[^>]*\b${JSONLD_CLASS}\b[^>]*>[\s\S]*?</script>`, "gi");

/** 이미 넣은 Related·JSON-LD 블록을 걷어 낸다(멱등 처리와 텍스트 보존 검증용). 나머지 글자·공백은 건드리지 않는다. */
export function stripTkmBlocks(html: string): string {
  return html.replace(RELATED_BLOCK_RE, "").replace(JSONLD_BLOCK_RE, "");
}

/**
 * 옛 발행본의 소제목(`<p ...><strong>제목</strong></p>` - 문단 전체가 굵은 글씨 하나)을 `<h2 ...>제목</h2>`로.
 * 문단 속성(font-size)은 그대로 옮긴다. 굵은 글씨가 문장 일부인 문단은 건드리지 않는다.
 */
const LEGACY_HEADING_RE = /<p\b([^>]*)>\s*<(strong|b)>((?:(?!<\/?(?:p|strong|b)\b)[\s\S])*?)<\/\2>\s*<\/p>/gi;

export function upgradeLegacyHeadings(html: string): { html: string; upgraded: number } {
  let upgraded = 0;
  const next = html.replace(LEGACY_HEADING_RE, (_match, attrs: string, _tag: string, inner: string) => {
    upgraded += 1;
    return `<h2${attrs}>${inner.trim()}</h2>`;
  });
  return { html: next, upgraded };
}

/** "References" 소제목(h2 또는 옛 굵은 문단). Related 블록은 바깥 출처 **앞**에 둔다 - appendRelatedPosts와 같은 자리. */
const REFERENCES_HEADING_RE = /<h2\b[^>]*>\s*References\s*<\/h2>/i;

export type ApplyTkmStructureResult = {
  html: string;
  /** 이번에 h2로 바꾼 옛 소제목 수. */
  upgradedHeadings: number;
  /** 결과 본문의 h2 수(Related 블록 제목 포함). */
  h2Count: number;
  relatedLinks: number;
  hasJsonLd: boolean;
};

/**
 * 본문 HTML에 구조 보강을 적용한다. 기존 블록은 걷고 새로 끼운다 - 몇 번을 돌려도 결과가 같다.
 * related/jsonLd가 null이면 그 블록은 넣지 않는다(기존 것도 지워진다).
 */
export function applyTkmStructure(html: string, input: { related: TkmRelated | null; jsonLd: TkmJsonLdInput | null }): ApplyTkmStructureResult {
  const { html: upgradedHtml, upgraded } = upgradeLegacyHeadings(stripTkmBlocks(html));
  let body = upgradedHtml;

  const match = input.related ? REFERENCES_HEADING_RE.exec(body) : null;
  const relatedHtml = input.related ? buildRelatedHtml(input.related, match ? "after" : "before") : "";
  if (relatedHtml) {
    body = match
      ? `${body.slice(0, match.index)}${relatedHtml}\n${body.slice(match.index)}`
      : `${body.replace(/\s+$/, "")}\n${relatedHtml}`;
  }
  const hasJsonLd = Boolean(input.jsonLd);
  if (input.jsonLd) body = `${body.replace(/\s+$/, "")}\n${buildJsonLdHtml(input.jsonLd)}`;

  return {
    html: body,
    upgradedHeadings: upgraded,
    h2Count: (body.match(/<h2\b/gi) ?? []).length,
    relatedLinks: input.related && relatedHtml ? input.related.similar.length + (input.related.previous ? 1 : 0) + (input.related.allGuidesUrl ? 1 : 0) : 0,
    hasJsonLd,
  };
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** 태그를 걷은 읽히는 글자. 변환 전후 비교용이라 공백 차이는 무시한다. */
export function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

/** 변환이 글자를 잃거나 더하지 않았는지(우리 블록 제외). */
export function sameVisibleText(before: string, after: string): boolean {
  return visibleText(stripTkmBlocks(before)) === visibleText(stripTkmBlocks(after));
}

/** JSON-LD description: 번역 산출물의 검색 설명(150자 내외)이 있으면 그것, 없으면 첫 문단을 160자 안에서 단어 경계로. */
export function describePost(html: string, searchDescription: string | null | undefined): string {
  const given = searchDescription?.replace(/\s+/g, " ").trim();
  if (given) return given;
  const firstParagraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(stripTkmBlocks(html).replace(/<p>&nbsp;<\/p>/g, ""));
  const text = visibleText(firstParagraph?.[1] ?? html);
  if (text.length <= 160) return text;
  const cut = text.slice(0, 157);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120)).trim()}...`;
}

export function firstImageUrl(html: string): string | null {
  const match = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(html);
  return match ? match[1].replace(/&amp;/g, "&") : null;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Seoul" });
}

/**
 * All Guides 페이지 본문. 라벨(주제)별로 묶고, 묶음 안은 최신순, 글 제목이 앵커 텍스트다.
 * 라벨 순서는 글이 많은 주제부터(같으면 이름순). 라벨이 여럿인 글은 첫 라벨에만 둔다.
 */
export function buildAllGuidesHtml(posts: readonly TkmPost[], fallbackLabel = "More Guides"): string {
  const groups = new Map<string, TkmPost[]>();
  for (const post of posts) {
    if (!post.url || !post.title) continue;
    const label = post.labels[0] ?? fallbackLabel;
    groups.set(label, [...(groups.get(label) ?? []), post]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const total = ordered.reduce((sum, [, list]) => sum + list.length, 0);
  const sections = ordered.map(([label, list]) => {
    const items = [...list]
      .sort((a, b) => b.published.localeCompare(a.published))
      .map((post) => {
        const date = formatDate(post.published);
        return `<li><a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a>${date ? ` <span style="color:#666">(${date})</span>` : ""}</li>`;
      })
      .join("");
    return `<h2 style="${HEADING_STYLE}">${escapeHtml(label)}</h2>\n<ul style="${BODY_STYLE}">${items}</ul>`;
  });
  return [
    `<p style="${BODY_STYLE}">Every guide on ${TKM_BRAND_NAME}, grouped by topic. Newest first within each topic. ${total} guides in total.</p>`,
    SPACER_HTML,
    sections.join(`\n${SPACER_HTML}\n`),
  ].join("\n");
}
