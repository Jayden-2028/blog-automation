// 인스타 게시물 하나를 열어 캐러셀 슬라이드를 찍는다(Playwright).
//
// **이 파일은 맥에서만 돈다.** 인스타는 로그인 없이 캐러셀 2번째 슬라이드부터 막으므로 로그인된
// 브라우저 프로필이 필요하다(IG_BROWSER_PROFILE). 클라우드 러너에는 그 프로필이 없다.
//
// 사용자가 지목한 URL **하나만** 연다 - 이슈 페이지를 훑는 탐색은 기각된 설계다
// (INSTAGRAM_KEYWORD_SOURCE.md). 범위를 넓히지 말 것.
//
// launchOptions는 captureRankingImage.ts와 같은 회피 인자를 쓴다(자동화 탐지 완화).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import type { CarouselCapture } from "./captureTypes.js";

const DEFAULT_MAX_SLIDES = 10;

/** 캐러셀 "다음" 버튼. 인스타가 DOM을 바꾸면 여기가 먼저 깨진다 - 0장이면 실패로 처리된다. */
const NEXT_BUTTON = 'button[aria-label="다음"], button[aria-label="Next"], [aria-label="Next"]';
const ARTICLE_IMAGE = "article img[srcset], article img[src]";

export function instagramProfilePath(): string | null {
  return process.env.IG_BROWSER_PROFILE?.trim() || null;
}

export async function captureInstagramCarousel(url: string): Promise<CarouselCapture> {
  const profile = instagramProfilePath();
  if (!profile) {
    throw new Error(
      "IG_BROWSER_PROFILE이 없습니다 - 인스타 로그인 프로필 경로를 .env에 넣어주세요(로그인 없이는 캐러셀이 막힙니다)."
    );
  }

  const maxSlides = Number(process.env.IG_CAPTURE_MAX_SLIDES) || DEFAULT_MAX_SLIDES;
  const tempDir = await mkdtemp(join(tmpdir(), "ig-capture-"));

  // persistent context라야 로그인 쿠키가 유지된다. headless여도 프로필은 그대로 쓴다.
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 1280 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 로그인 벽이 뜨면 여기서 걸린다 - article이 안 나타난다.
    await page.waitForSelector("article", { timeout: 30_000 }).catch(() => {
      throw new Error("게시물을 열지 못했습니다(로그인 만료 또는 비공개 게시물 의심).");
    });

    const caption = await page
      .locator("article h1, article [data-testid='post-comment-root'] span")
      .first()
      .innerText()
      .catch(() => "");

    const slides: CarouselCapture["slides"] = [];
    const seen = new Set<string>();

    for (let i = 1; i <= maxSlides; i += 1) {
      const image = page.locator(ARTICLE_IMAGE).first();
      if ((await image.count()) === 0) break;

      // 같은 이미지를 두 번 찍으면(다음 버튼이 안 먹었다) 거기서 멈춘다.
      const src = (await image.getAttribute("src").catch(() => null)) ?? "";
      if (src && seen.has(src)) break;
      if (src) seen.add(src);

      const localPath = join(tempDir, `slide-${i}.png`);
      await image.screenshot({ path: localPath });
      slides.push({ slideIndex: i, localPath });

      const next = page.locator(NEXT_BUTTON).first();
      if ((await next.count()) === 0) break;   // 단일 이미지 게시물
      await next.click({ timeout: 5_000 }).catch(() => null);
      await page.waitForTimeout(600);
    }

    return { slides, caption: caption.trim(), tempDir };
  } finally {
    await context.close().catch(() => {});
  }
}
