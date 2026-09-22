// 인스타 게시물 하나를 열어 캐러셀 슬라이드를 찍는다(Playwright).
//
// **이 파일은 맥에서만 돈다.** 인스타는 로그인 없이 캐러셀 2번째 슬라이드부터 막으므로 로그인된
// 브라우저 프로필이 필요하다(IG_BROWSER_PROFILE). 클라우드 러너에는 그 프로필이 없다.
//
// 사용자가 지목한 URL **하나만** 연다 - 이슈 페이지를 훑는 탐색은 기각된 설계다
// (INSTAGRAM_KEYWORD_SOURCE.md). 범위를 넓히지 말 것.
//
// launchOptions는 captureRankingImage.ts와 같은 회피 인자를 쓴다(자동화 탐지 완화).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import type { CarouselCapture } from "./captureTypes.js";

const DEFAULT_MAX_SLIDES = 10;

/** 캐러셀 "다음" 버튼. 인스타가 DOM을 바꾸면 여기가 먼저 깨진다 - 0장이면 실패로 처리된다. */
const NEXT_BUTTON = 'button[aria-label="다음"], button[aria-label="Next"], [aria-label="Next"], [aria-label="다음"]';

/**
 * 게시물 컨테이너 **안쪽만** 본다.
 *
 * 맨몸 `img[srcset]`을 폴백에 두면 안 된다(2026-09-22에 뺐다): 인스타가 게시물을 못 열고 홈 피드로
 * 되돌려보내면 그 선택자가 **피드 이미지에 걸려** 엉뚱한 게시물을 조용히 찍는다. 실패하는 것보다
 * 나쁘다 - 원고에 다른 사람 사진이 들어가고 아무도 모른다.
 */
const POST_CONTAINER = 'article, main [role="dialog"]';
const ARTICLE_IMAGE = `${POST_CONTAINER} img[srcset], ${POST_CONTAINER} img[src]`;

/** 공유 링크의 추적 파라미터(utm_source, stkn 등)를 떼고 표준 주소로 맞춘다. */
export function canonicalPostUrl(url: string): { url: string; shortcode: string } | null {
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) return null;
  return { url: `https://www.instagram.com/p/${match[1]}/`, shortcode: match[1] };
}

export function instagramProfilePath(): string | null {
  return process.env.IG_BROWSER_PROFILE?.trim() || null;
}

export type CaptureOptions = {
  /** 헤드리스로 띄울지. 인스타는 헤드리스를 탐지해 로그인 벽을 띄우는 일이 있다. */
  headless?: boolean;
};

/**
 * 게시물이 안 열렸을 때 **무엇이 떴는지** 남긴다. 이게 없으면 "로그인 만료 의심"이라는 추측만
 * 남고 원인(로그인 벽 / 동의 배너 / 챌린지 / 레이아웃 변경)을 가릴 수 없다.
 */
async function dumpDiagnostics(page: import("playwright").Page, tempDir: string): Promise<string> {
  const shot = join(tempDir, "failure.png");
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  const title = await page.title().catch(() => "(제목 없음)");
  const current = page.url();
  // page.evaluate는 DOM 타입(lib.dom)이 필요한데 이 프로젝트 tsconfig에는 없다 - locator로 읽는다.
  const text = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 2000);
  await writeFile(
    join(tempDir, "failure.txt"),
    [`title: ${title}`, `url: ${current}`, "", "--- body text (앞 2000자) ---", text].join("\n"),
    "utf8"
  ).catch(() => {});
  return `화면: ${shot} / 텍스트: ${join(tempDir, "failure.txt")} (title="${title}")`;
}

export async function captureInstagramCarousel(
  url: string,
  options: CaptureOptions = {}
): Promise<CarouselCapture> {
  const profile = instagramProfilePath();
  if (!profile) {
    throw new Error(
      "IG_BROWSER_PROFILE이 없습니다 - 인스타 로그인 프로필 경로를 .env에 넣어주세요(로그인 없이는 캐러셀이 막힙니다)."
    );
  }

  const maxSlides = Number(process.env.IG_CAPTURE_MAX_SLIDES) || DEFAULT_MAX_SLIDES;
  const tempDir = await mkdtemp(join(tmpdir(), "ig-capture-"));

  // persistent context라야 로그인 쿠키가 유지된다. headless여도 프로필은 그대로 쓴다.
  // 기본 헤드리스지만 IG_CAPTURE_HEADLESS=false로 끌 수 있다 - 인스타가 헤드리스를 탐지해 로그인
  // 벽을 띄우면 창을 띄우는 쪽이 유일한 우회다(맥에 사람이 있으니 창이 떠도 된다).
  const headless = options.headless ?? process.env.IG_CAPTURE_HEADLESS !== "false";

  const context = await chromium.launchPersistentContext(profile, {
    headless,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 1280 },
    // 헤드리스 기본 UA에는 "HeadlessChrome"이 박혀 있어 그대로 탐지된다.
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "ko-KR",
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    const canonical = canonicalPostUrl(url);
    if (!canonical) throw new Error(`인스타 게시물 주소가 아닙니다: ${url}`);
    await page.goto(canonical.url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 로그인 벽이 뜨면 여기서 걸린다 - article이 안 나타난다.
    // 되돌려보내졌는지 먼저 본다. 로그인 벽·삭제된 게시물·차단이면 인스타는 홈이나 로그인으로
    // 보내는데, 그 화면에도 이미지가 많아 선택자만으로는 구분되지 않는다.
    if (!page.url().includes(`/p/${canonical.shortcode}`)) {
      const where = await dumpDiagnostics(page, tempDir);
      throw new Error(
        `게시물로 못 갔습니다 - ${page.url()} 로 되돌려보내졌습니다(삭제·비공개·로그인 벽 중 하나). ${where}`
      );
    }

    const ready = await page
      .waitForSelector(ARTICLE_IMAGE, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      const where = await dumpDiagnostics(page, tempDir);
      throw new Error(
        `게시물을 열지 못했습니다(로그인 벽·동의 배너·레이아웃 변경 중 하나). ${where}\n` +
          `   창을 띄워 눈으로 보려면: IG_CAPTURE_HEADLESS=false npm run ig:capture -- <id> --dry-run --keep`
      );
    }

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
