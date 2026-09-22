// 슬라이드 한 장을 구글 렌즈에 올려 **같은 사진**을 찾는다(설계서 2-b단계).
//
// 왜 필요한가: 2-a단계(텍스트 검색)는 "같은 주제 사진"이지 "같은 사진"이 아니다. 실측에서
// 엉뚱한 출처가 붙었다(job ec21f085 - 다른 인스타 게시물).
//
// 왜 전용 프로필인가: lens.google.com은 자동화 트래픽에 CAPTCHA(/sorry/index)를 띄운다.
// 2026-09-23 실측에서 헤드리스든 창을 띄우든 익명 컨텍스트는 막혔다. 로그인된 크롬 프로필로는
// 통과했다. 보장이 아니라 확률이므로 막히면 조용히 2-a로 떨어진다. CAPTCHA는 풀지 않는다.
//
// 왜 해시 매칭이 필요한가(2026-09-23 실측): 렌즈가 지목하는 것은 **페이지**다. 그 페이지의
// og:image를 그대로 쓰면 기사 대표 이미지가 와서 다른 사진이 된다 - 인스타는 정우성·박정민
// 2인 사진인데 4개월 전 기사의 3인 사진이 왔다. 렌즈 결과 카드의 **썸네일이 곧 매칭된
// 사진**이므로, 그걸 기준으로 페이지 이미지들을 지각 해시(dHash)로 비교해 같은 것만 고른다.
//
// 새 라이브러리를 붙이지 않는다. 이미지 디코딩은 **이미 띄운 브라우저의 canvas**로 한다.
import { parse as parseHtml } from "node-html-parser";
import { chromium } from "playwright";
import type { Page } from "playwright";

import { isBlockedSource, hostOf } from "./blockedSources.js";
import type { ImageCandidate } from "../images/searchNaverImages.js";

/** 구글 로그인 프로필 경로(맥 전용). 없으면 리버스 검색을 건너뛴다. */
export function lensProfilePath(): string | null {
  return process.env.LENS_BROWSER_PROFILE?.trim() || null;
}

/** 리버스 검색을 켤지. 기본 꺼짐 - 프로필이 준비되기 전에 켜면 매번 헛돈다. */
export function reverseSearchEnabled(): boolean {
  return process.env.LENS_REVERSE_SEARCH === "true";
}

/**
 * "같은 사진"으로 인정할 dHash 거리 상한(64비트 중 다른 비트 수).
 *
 * 같은 사진이 크기·압축·약간의 크롭만 다르면 보통 0~10에 들어오고, 다른 사진은 25 이상으로
 * 벌어진다. 12는 그 사이에서 **놓치는 쪽보다 잘못 집는 쪽을 더 경계한** 값이다 - 잘못 집으면
 * 사람이 "같은 사진"이라는 말을 믿고 넘긴다. 놓치면 2-a가 받아준다.
 */
export const MATCH_MAX_DISTANCE = 12;

export type MatchedCandidate = ImageCandidate & { matchDistance: number };

export type ReverseSearchResult =
  | { status: "ok"; candidates: MatchedCandidate[] }
  | { status: "skipped"; reason: string }
  | { status: "blocked" }
  | { status: "failed"; error: string };

/** 결과에서 버릴 도메인. 구글 자체 링크와 이미지 호스팅은 출처 페이지가 못 된다. */
const NOISE = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|youtube\.com|schema\.org)$/i;

/** 렌즈가 지목한 "이 사진이 실린 페이지"와 그 카드의 썸네일(= 매칭된 사진). */
export type LensHit = { sourcePage: string; title: string; thumbnail: string };

/**
 * 렌즈 결과에서 출처 페이지와 썸네일을 짝지어 뽑는다.
 *
 * 썸네일은 205px짜리 `data:` URI이고 `<a>` 바깥에 있다 - 실측에서 조상 6단계 안에 링크가
 * 있어 카드 단위로 짝이 맞는다. 이 썸네일이 해시 비교의 **기준**이다.
 */
export function extractHits(rows: Array<{ href: string; title: string; thumbnail: string }>): LensHit[] {
  const seen = new Set<string>();
  const out: LensHit[] = [];
  for (const row of rows) {
    const host = hostOf(row.href);
    if (!host || NOISE.test(host)) continue;
    // 인스타는 2-a와 같은 이유로 뺀다. 여기서 걸러야 쓸데없이 페이지를 받지 않는다.
    if (isBlockedSource({ sourcePage: row.href })) continue;
    if (!row.thumbnail.startsWith("data:image/")) continue;
    if (seen.has(row.href)) continue;
    seen.add(row.href);
    out.push({ sourcePage: row.href, title: row.title, thumbnail: row.thumbnail });
  }
  return out;
}

/**
 * HTML 속성값의 엔티티를 푼다.
 *
 * 2026-09-23 실측: X(트위터)의 og:image가 `?format=webp&amp;name=large`로 나와 그대로 받으면
 * 404다. `&amp;`가 쿼리 구분자를 망가뜨린다.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&(?:amp|AMP);/g, "&")
    .replace(/&(?:quot|QUOT);/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&(?:lt|LT);/g, "<")
    .replace(/&(?:gt|GT);/g, ">")
    .replace(/&#0*(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function absolute(value: string, pageUrl: string): string | null {
  try {
    const url = new URL(decodeEntities(value.trim()), pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 출처 페이지에서 해시를 비교해 볼 이미지 후보를 뽑는다.
 *
 * og:image를 앞에 둔다 - 기사 대표 이미지가 우리가 찾는 사진인 경우가 가장 흔하다. 그 뒤로
 * 본문 img를 붙인다. 그게 있어야 "같은 사진이 본문 두 번째 사진인" 경우를 집는다.
 */
export function pickPageImages(html: string, pageUrl: string, cap = 6): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (!value) return;
    const url = absolute(value, pageUrl);
    if (!url) return;
    if (isBlockedSource({ link: url })) return;
    if (!out.includes(url)) out.push(url);
  };

  const root = parseHtml(html.slice(0, 500_000));
  for (const selector of [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
  ]) {
    for (const meta of root.querySelectorAll(selector)) push(meta.getAttribute("content"));
  }
  for (const img of root.querySelectorAll("img")) {
    if (out.length >= cap) break;
    push(img.getAttribute("src") ?? img.getAttribute("data-src"));
  }
  return out.slice(0, cap);
}

/** 두 dHash(16진수 문자열)의 다른 비트 수. 길이가 다르면 비교 불가로 본다. */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = parseInt(a[i], 16);
    const right = parseInt(b[i], 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return Number.MAX_SAFE_INTEGER;
    let x = left ^ right;
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/**
 * 브라우저 canvas로 dHash(64비트)를 계산한다.
 *
 * 왜 브라우저인가: 이 저장소에는 이미지 디코더가 없고(sharp/jimp 없음), 렌즈 때문에 어차피
 * 크롬이 떠 있다. 새 네이티브 의존성을 들이는 것보다 낫다.
 *
 * 왜 문자열 evaluate인가: tsconfig에 DOM lib이 없어 `document`를 타입으로 못 쓴다. 이 한
 * 군데만 문자열로 넘긴다(입력 URI는 JSON.stringify로 리터럴에 박는다).
 */
async function dHash(page: Page, dataUri: string): Promise<string | null> {
  const script = `(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("load")); img.src = ${JSON.stringify(
      dataUri
    )}; });
    const W = 9, H = 8;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d");
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let bits = "";
    for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
      const i = (y * W + x) * 4, j = (y * W + x + 1) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      const r = 0.299 * d[j] + 0.587 * d[j+1] + 0.114 * d[j+2];
      bits += l > r ? "1" : "0";
    }
    let hex = "";
    for (let k = 0; k < 64; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
    return hex;
  })()`;
  try {
    const value = await page.evaluate<string>(script);
    return typeof value === "string" && value.length === 16 ? value : null;
  } catch {
    return null;
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** 너무 큰 파일은 해시하려고 받지 않는다 - 원고에 쓸 사진은 이보다 작다. */
const MAX_IMAGE_BYTES = 8_000_000;

async function downloadHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * 해시하려고 이미지를 data: URI로 받는다.
 *
 * 왜 data: URI인가: 브라우저에서 원격 이미지를 canvas에 그리면 CORS 때문에 getImageData가
 * 막힌다(tainted canvas). data:는 동일 출처라 그 문제가 없다.
 */
async function downloadAsDataUri(url: string, referer: string | null): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": BROWSER_UA, Accept: "image/*,*/*;q=0.8" };
    if (referer) headers.Referer = referer;
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export type ReverseSearchDeps = {
  /** 테스트에서 렌즈+해시 전체를 갈아끼운다(브라우저를 실제로 띄우지 않는다). */
  collect?: (slidePath: string, profile: string) => Promise<MatchedCandidate[] | "blocked">;
};

/** 렌즈 결과 카드에서 (출처 링크, 제목, 썸네일)을 읽는다. */
async function readCards(page: Page): Promise<Array<{ href: string; title: string; thumbnail: string }>> {
  const script = `(() => {
    const rows = [];
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const box = img.getBoundingClientRect();
      // 파비콘(14px)·아바타를 거른다. 결과 카드 썸네일은 205px다.
      if (box.width < 120) continue;
      let el = img, href = null, title = "", depth = 0;
      while (el && depth < 8) {
        const a = el.querySelector && el.querySelector('a[href^="http"]');
        if (a) { href = a.href; title = (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 120); break; }
        el = el.parentElement; depth++;
      }
      if (href) rows.push({ href, title, thumbnail: img.src || "" });
    }
    return rows;
  })()`;
  return (await page.evaluate<Array<{ href: string; title: string; thumbnail: string }>>(script)) ?? [];
}

/** 렌즈에 올리고, 결과 카드의 썸네일과 같은 사진을 출처 페이지에서 집어낸다. */
async function collectWithBrowser(slidePath: string, profile: string): Promise<MatchedCandidate[] | "blocked"> {
  const context = await chromium.launchPersistentContext(profile, {
    headless: process.env.LENS_HEADLESS !== "false",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 1600 },
    userAgent: BROWSER_UA,
    locale: "ko-KR",
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://lens.google.com/upload", { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 2026-09-23 실측으로 확인한 선택자. 대화상자 안에도 file input이 둘 있지만 파일을 받아도
    // 검색이 발화되지 않는다 - 발화하는 것은 name="encoded_image" 하나다.
    const input = page.locator('input[name="encoded_image"]');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(slidePath);

    await page.waitForURL(/\/search|\/sorry/, { timeout: 60_000 }).catch(() => {});
    if (page.url().includes("/sorry")) return "blocked";

    // **"정확히 일치하는 결과" 탭으로 간다**(2026-09-23 실측).
    //
    // 기본 화면은 "시각적으로 일치하는 항목"이다. 그건 같은 사진이 아니라 비슷해 보이는
    // 사진까지 담는다 - 암살자(들) 슬라이드(정우성·박정민 2인)에 신유열 단독 증명사진이
    // 1위로 올라왔다. "얼굴 하나가 밝은 배경에" 정도만 맞아도 걸린다.
    //
    // 정확히 일치 탭은 **그 사진이 실제로 실린 페이지**만 준다. 탭이 없으면(결과가 적으면
    // 안 뜬다) 그냥 포기한다 - 시각적 유사로 내려가면 엉뚱한 사진을 "같은 사진"이라고
    // 내주게 된다.
    const exactTab = page.locator('a:has-text("정확히 일치하는 결과"), a:has-text("완전일치")').first();
    if ((await exactTab.count().catch(() => 0)) === 0) return [];
    await exactTab.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // 결과가 비동기로 채워진다. **필터를 통과한** 카드가 생길 때까지 기다린다 - 원시 카드
    // 개수로 기다리면 결과가 붙기 전의 구글 자체 이미지에 걸려 곧바로 빠져나오고, 그다음
    // 필터에서 0개가 된다(2026-09-23 실측: 5초 만에 후보 0개로 끝났다).
    // 일치가 없으면 구글이 그렇게 적어준다("일치검색 결과를 찾을 수 없음"). 그 화면을 15초씩
    // 기다리면 오버레이 슬라이드마다 헛되이 느려진다 - 문구가 보이면 즉시 포기한다.
    const emptyNotice = page.locator('text=일치검색 결과를 찾을 수 없음, text=No matching results');
    let hits: LensHit[] = [];
    for (let i = 0; i < 10; i += 1) {
      hits = extractHits(await readCards(page).catch(() => []));
      if (hits.length > 0) break;
      if ((await emptyNotice.count().catch(() => 0)) > 0) return [];
      await page.waitForTimeout(1000);
    }
    const matched: MatchedCandidate[] = [];

    for (const hit of hits.slice(0, 6)) {
      if (matched.length >= 3) break;

      // 기준은 렌즈 썸네일이다 - 그게 "렌즈가 같다고 판단한 그 사진"이다.
      const reference = await dHash(page, hit.thumbnail);
      if (!reference) continue;

      const html = await downloadHtml(hit.sourcePage);
      if (!html) continue;

      let best: { url: string; distance: number } | null = null;
      for (const url of pickPageImages(html, hit.sourcePage)) {
        const uri = await downloadAsDataUri(url, hit.sourcePage);
        if (!uri) continue;
        const hash = await dHash(page, uri);
        if (!hash) continue;
        const distance = hammingHex(reference, hash);
        if (!best || distance < best.distance) best = { url, distance };
        if (distance === 0) break;
      }

      if (!best || best.distance > MATCH_MAX_DISTANCE) continue;
      matched.push({
        title: hit.title,
        link: best.url,
        thumbnail: best.url,
        // 크기는 모른다 - usable()이 크기 미상 후보는 남긴다.
        width: null,
        height: null,
        sourcePage: hit.sourcePage,
        matchDistance: best.distance,
      });
    }

    return matched.sort((a, b) => a.matchDistance - b.matchDistance);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 같은 사진의 출처 후보를 돌려준다.
 *
 * 못 구하면 빈 배열이 아니라 status로 알린다 - 호출자가 "막혔다"와 "결과가 없다"를 구분해
 * 로그를 남길 수 있어야 한다. 해시가 안 맞으면 후보를 내지 않는다: 같은 사진을 찾는 것이
 * 이 단계의 존재 이유이고, 아쉬운 대로 비슷한 것을 내주는 일은 2-a가 한다.
 */
export async function reverseImageSearch(
  slidePath: string,
  deps: ReverseSearchDeps = {}
): Promise<ReverseSearchResult> {
  if (!reverseSearchEnabled()) return { status: "skipped", reason: "LENS_REVERSE_SEARCH가 true가 아닙니다." };
  const profile = lensProfilePath();
  if (!profile) return { status: "skipped", reason: "LENS_BROWSER_PROFILE이 없습니다(npm run ig:lens-login)." };

  const collect = deps.collect ?? collectWithBrowser;
  try {
    const candidates = await collect(slidePath, profile);
    if (candidates === "blocked") return { status: "blocked" };
    return { status: "ok", candidates };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
