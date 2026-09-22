// 슬라이드 한 장을 구글 렌즈에 올려 **같은 사진**의 출처를 찾는다(설계서 2-b단계).
//
// 왜 필요한가: 2-a단계(텍스트 검색)는 "같은 주제 사진"이지 "같은 사진"이 아니다. 실측에서
// 엉뚱한 출처가 붙었다(job ec21f085 - 다른 인스타 게시물). 리버스 검색은 같은 사진을 실은
// 페이지를 직접 돌려주므로 출처가 정확하다.
//
// 왜 전용 프로필인가: lens.google.com은 자동화 트래픽에 CAPTCHA(/sorry/index)를 띄운다.
// 2026-09-23 실측에서 헤드리스든 창을 띄우든 똑같이 막혔다. 로그인된 크롬 프로필을 쓰면
// 사람 트래픽으로 보일 가능성이 높아진다 - 인스타 캡처가 쓰는 것과 같은 수법이다.
// **그래도 막힐 수 있다.** 막히면 조용히 빈 배열을 돌려주고 호출자가 2-a로 떨어진다.
//
// CAPTCHA를 풀지 않는다. 뜨면 포기한다.
import { chromium } from "playwright";

import type { ImageCandidate } from "../images/searchNaverImages.js";

/** 구글 로그인 프로필 경로(맥 전용). 없으면 리버스 검색을 건너뛴다. */
export function lensProfilePath(): string | null {
  return process.env.LENS_BROWSER_PROFILE?.trim() || null;
}

/** 리버스 검색을 켤지. 기본 꺼짐 - 프로필이 준비되기 전에 켜면 매번 헛돈다. */
export function reverseSearchEnabled(): boolean {
  return process.env.LENS_REVERSE_SEARCH === "true";
}

export type ReverseSearchResult =
  | { status: "ok"; candidates: ImageCandidate[] }
  | { status: "skipped"; reason: string }
  | { status: "blocked" }
  | { status: "failed"; error: string };

/** 결과에서 버릴 도메인. 구글 자체 링크와 이미지 호스팅은 출처 페이지가 못 된다. */
const NOISE = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|youtube\.com|schema\.org)$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 렌즈 결과 페이지에서 "이 사진이 실린 페이지" 후보를 긁는다.
 *
 * 링크마다 붙어 있는 썸네일(img)을 같이 집어 ImageCandidate로 만든다. 썸네일은 렌즈가 주는
 * 저해상도라 그대로 쓰지 않고, 출처 페이지를 열어 받는 것은 기존 다운로드 경로가 한다.
 */
export function extractCandidates(
  rows: Array<{ href: string; text: string; image: string | null; width: number | null; height: number | null }>
): ImageCandidate[] {
  const seen = new Set<string>();
  const out: ImageCandidate[] = [];
  for (const row of rows) {
    const host = hostOf(row.href);
    if (!host || NOISE.test(host)) continue;
    if (seen.has(row.href)) continue;
    seen.add(row.href);
    // link(이미지 직접 주소)가 없으면 쓸 수 없다 - 받을 대상이 없다.
    if (!row.image) continue;
    out.push({
      title: row.text,
      link: row.image,
      thumbnail: row.image,
      width: row.width,
      height: row.height,
      sourcePage: row.href,
    });
  }
  return out;
}

export type ReverseSearchDeps = {
  /** 테스트에서 브라우저를 갈아끼운다. */
  collect?: (slidePath: string, profile: string) => Promise<ReverseSearchResult>;
};

async function collectWithBrowser(slidePath: string, profile: string): Promise<ReverseSearchResult> {
  // 로그인 쿠키가 유지돼야 하므로 persistent context. 인스타 캡처와 같은 회피 인자를 쓴다.
  const context = await chromium.launchPersistentContext(profile, {
    headless: process.env.LENS_HEADLESS !== "false",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 1600 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "ko-KR",
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://lens.google.com/upload", { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 2026-09-23 실측으로 확인한 선택자. 대화상자 안에도 file input이 있지만 그쪽은 아무 일도
    // 일어나지 않는다 - 검색을 실제로 발화하는 것은 name="encoded_image" 하나다.
    const input = page.locator('input[name="encoded_image"]');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(slidePath);

    await page.waitForURL(/\/search|\/sorry/, { timeout: 60_000 }).catch(() => {});
    if (page.url().includes("/sorry")) return { status: "blocked" };

    // 결과가 비동기로 채워진다. 링크가 붙을 때까지 짧게 폴링한다 - page.evaluate로 document를
    // 만지지 않는 것은 이 저장소의 관례다(tsconfig에 DOM lib이 없다). 로케이터로만 읽는다.
    const links = page.locator('a[href^="http"]');
    for (let i = 0; i < 20; i += 1) {
      if ((await links.count().catch(() => 0)) > 5) break;
      await page.waitForTimeout(1000);
    }

    const total = Math.min(await links.count().catch(() => 0), 60);
    const rows: Array<{ href: string; text: string; image: string | null; width: number | null; height: number | null }> =
      [];
    for (let i = 0; i < total; i += 1) {
      const anchor = links.nth(i);
      const href = await anchor.getAttribute("href").catch(() => null);
      if (!href) continue;
      const img = anchor.locator("img").first();
      const image = (await img.count().catch(() => 0)) > 0 ? await img.getAttribute("src").catch(() => null) : null;
      const box = image ? await img.boundingBox().catch(() => null) : null;
      rows.push({
        href,
        text: ((await anchor.innerText().catch(() => "")) || (await anchor.getAttribute("aria-label").catch(() => "")) || "")
          .trim()
          .slice(0, 120),
        image,
        width: box ? Math.round(box.width) : null,
        height: box ? Math.round(box.height) : null,
      });
    }

    return { status: "ok", candidates: extractCandidates(rows) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 같은 사진의 출처 후보를 돌려준다. 어떤 이유로든 못 구하면 빈 배열이 아니라 status로 알린다 -
 * 호출자가 "막혔다"와 "결과가 없다"를 구분해 로그를 남길 수 있어야 한다.
 */
export async function reverseImageSearch(
  slidePath: string,
  deps: ReverseSearchDeps = {}
): Promise<ReverseSearchResult> {
  if (!reverseSearchEnabled()) return { status: "skipped", reason: "LENS_REVERSE_SEARCH가 true가 아닙니다." };
  const profile = lensProfilePath();
  if (!profile) return { status: "skipped", reason: "LENS_BROWSER_PROFILE이 없습니다(npm run ig:lens-login)." };

  const collect = deps.collect ?? collectWithBrowser;
  return collect(slidePath, profile);
}
