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
/**
 * 캐러셀 "다음" 컨트롤 후보.
 *
 * 라벨이 로케일·실험마다 달라서 한 문자열로는 못 잡는다. 부분 일치(*=)까지 써서 넓게 훑고,
 * 그래도 못 찾으면 goToNextSlide가 키보드 화살표로 떨어진다.
 */
const NEXT_BUTTON = [
  'button[aria-label="다음"]',
  'button[aria-label="Next"]',
  '[aria-label="다음"]',
  '[aria-label="Next"]',
  '[aria-label*="다음"]',
  '[aria-label*="Next" i]',
].join(", ");

/**
 * 게시물 컨테이너 **안쪽만** 본다.
 *
 * 맨몸 `img`를 페이지 전체에서 고르면 안 된다: 인스타가 게시물을 못 열고 홈 피드로 되돌려보내면
 * 그 선택자가 **피드 이미지에 걸려** 엉뚱한 게시물을 조용히 찍는다. 실패보다 나쁘다 - 원고에
 * 다른 사람 사진이 들어가고 아무도 모른다. 주소 검증(아래)과 짝으로 막는다.
 *
 * `article`과 `srcset`은 쓰지 않는다(2026-09-22 실측): 실제 페이지에서 article 0개, img[srcset]
 * 0개, img 17개였다. 예전 선택자가 둘 다 요구해 30초를 기다리다 포기했다.
 */
const POST_CONTAINER = 'main [role="dialog"], main, article';
/**
 * 페이지 전체의 img에서 고른다.
 *
 * main 안쪽으로 한정했다가 본문 사진을 통째로 놓쳤다(2026-09-22 실측: img 17개인데 조건을
 * 만족하는 게 0개). 컨테이너 구조는 실험마다 바뀌므로 겨냥하지 않는다 - "다른 게시물을 찍는"
 * 위험은 이동 후 **주소 검증**(/p/<shortcode>)이 이미 막고 있어 범위를 좁힐 이유가 없다.
 */
const POST_IMAGE = "img";

/**
 * 이미지 출처 필터. data:/blob:도 받는다 - 인스타가 blob URL로 내려주는 경우가 있고, 그걸
 * 거르면 본문 사진이 통째로 빠진다.
 */
const IG_CDN = /cdninstagram|fbcdn|^blob:|^data:image/i;
/** 본문 사진으로 볼 최소 렌더 크기(px). 프로필 아바타는 32~56px라 이걸로 걸러진다. */
const MIN_RENDERED = 200;

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
/**
 * 어떤 선택자가 실제로 몇 개 잡히는지 센다.
 *
 * 이게 없으면 "article이 없나 보다"를 추측으로 고치고 다시 돌려보기를 반복하게 된다 - 인스타
 * DOM은 로그인 상태·레이아웃 실험마다 달라서 한 번에 맞히기 어렵다. 한 번 돌려 이 표만 보면
 * 무엇을 겨냥해야 하는지 바로 정해진다.
 */
const PROBE_SELECTORS = [
  "article",
  'main [role="dialog"]',
  "main",
  "article img[srcset]",
  "main img[srcset]",
  "main img",
  "img[srcset]",
  "img",
  '[aria-label="슬라이드"]',
  '[aria-label="슬라이드"] img',
  'button[aria-label="다음"]',
  'button[aria-label="Next"]',
  '[aria-label="다음"]',
  '[role="button"]',
  "video",
  'input[name="username"]',
];

async function probeSelectors(page: import("playwright").Page): Promise<string> {
  const rows: string[] = [];
  for (const selector of PROBE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => -1);
    rows.push(`  ${String(count).padStart(4)}  ${selector}`);
  }
  return rows.join("\n");
}

/**
 * 페이지의 img를 **전부** 훑어 크기·출처를 적는다.
 *
 * 선택자 개수만으로는 "img 17개인데 왜 하나도 안 걸리나"를 못 푼다 - 크기가 작아서인지,
 * src가 예상한 CDN이 아닌지, main 밖에 있는지 알 수 없기 때문이다. 한 장씩 실측을 적으면
 * 필터를 어디서 고쳐야 하는지가 바로 나온다.
 */
async function inventoryImages(page: import("playwright").Page): Promise<string> {
  const all = page.locator("img");
  const count = Math.min(await all.count().catch(() => 0), 30);
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const el = all.nth(i);
    const src = (await el.getAttribute("src").catch(() => null)) ?? "";
    const alt = (await el.getAttribute("alt").catch(() => null)) ?? "";
    const box = await el.boundingBox().catch(() => null);
    const size = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "(안 보임)";
    const kind = src.startsWith("blob:") ? "blob" : src.startsWith("data:") ? "data" : new URL(src, "https://x/").hostname;
    rows.push(`  ${String(i).padStart(2)}  ${size.padEnd(11)} ${kind.padEnd(28)} alt="${alt.slice(0, 40)}"`);
  }
  return rows.join("\n") || "  (img 없음)";
}

async function dumpDiagnostics(page: import("playwright").Page, tempDir: string): Promise<string> {
  const shot = join(tempDir, "failure.png");
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  const title = await page.title().catch(() => "(제목 없음)");
  const current = page.url();
  // page.evaluate는 DOM 타입(lib.dom)이 필요한데 이 프로젝트 tsconfig에는 없다 - locator로 읽는다.
  const text = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 2000);
  const probe = await probeSelectors(page);
  const images = await inventoryImages(page);
  // 실제로 쓰이는 aria-label을 모아 둔다 - "다음" 버튼 라벨이 로케일·실험마다 달라서,
  // 목록을 보면 무엇을 겨냥해야 하는지 바로 정해진다(고정 문자열로는 계속 빗나간다).
  const labels = await page
    .locator("[aria-label]")
    .evaluateAll((nodes) => Array.from(new Set(nodes.map((n) => n.getAttribute("aria-label") ?? ""))).filter(Boolean))
    .catch(() => [] as string[]);
  // HTML 원본도 남긴다 - 선택자를 고치려면 구조를 봐야 한다.
  const html = await page.content().catch(() => "");
  await writeFile(join(tempDir, "failure.html"), html, "utf8").catch(() => {});
  await writeFile(
    join(tempDir, "failure.txt"),
    [
      `title: ${title}`,
      `url: ${current}`,
      "",
      "--- 선택자별 개수 (이 표가 핵심) ---",
      probe,
      "",
      "--- img 실측 (크기 / 호스트 / alt) ---",
      images,
      "",
      `--- 페이지의 aria-label ${labels.length}개 ---`,
      labels.map((l) => `  ${l}`).join("\n"),
      "",
      "--- body text (앞 2000자) ---",
      text,
    ].join("\n"),
    "utf8"
  ).catch(() => {});

  // 터미널에도 바로 찍는다 - 파일을 열어 보기 전에 원인이 드러나는 일이 많다.
  console.error("\n--- 선택자별 개수 ---");
  console.error(probe);
  console.error("\n--- img 실측 (크기 / 호스트 / alt) ---");
  console.error(images);
  if (labels.length > 0) {
    console.error(`\n--- aria-label ${labels.length}개 ---`);
    console.error(labels.map((l) => `  ${l}`).join("\n"));
  }

  return `화면: ${shot} / 진단: ${join(tempDir, "failure.txt")} / HTML: ${join(tempDir, "failure.html")}`;
}

type PostImage = { locator: import("playwright").Locator; src: string; width: number };

/**
 * 지금 보이는 **본문 사진**을 고른다.
 *
 * 페이지에는 아바타·아이콘·추천 썸네일까지 섞여 17개 남짓의 img가 있다(2026-09-22 실측).
 * 인스타 CDN에서 온 것 중 **가장 크게 렌더된 것**이 본문 사진이다 - 아바타는 32~56px이고
 * 추천 썸네일도 본문보다 작다. 크기로 고르면 클래스명이 바뀌어도 따라갈 필요가 없다.
 */
async function currentPostImage(page: import("playwright").Page): Promise<PostImage | null> {
  const all = page.locator(POST_IMAGE);
  const count = await all.count().catch(() => 0);

  let best: PostImage | null = null;
  for (let i = 0; i < count; i += 1) {
    const locator = all.nth(i);
    const src = (await locator.getAttribute("src").catch(() => null)) ?? "";
    if (!IG_CDN.test(src)) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width < MIN_RENDERED || box.height < MIN_RENDERED) continue;
    if (!best || box.width > best.width) best = { locator, src, width: box.width };
  }
  return best;
}

/**
 * 캐러셀을 한 칸 넘긴다. 넘길 곳이 없으면 false(단일 이미지 게시물).
 *
 * "다음" 버튼은 **이미지에 마우스를 올려야** 나타나고, aria-label도 로케일·실험마다 달라서
 * 고정 문자열로 잡으면 놓친다(실측: button[aria-label="다음"] 0개, [role=button] 30개).
 * 그래서 (1) 호버 후 알려진 라벨들을 훑고, (2) 그래도 없으면 키보드 오른쪽 화살표를 쓴다.
 * 넘어갔는지는 호출자가 src 변화로 판정하므로 여기서 거짓 성공을 내도 루프가 알아서 멈춘다.
 */
async function goToNextSlide(page: import("playwright").Page, current: PostImage): Promise<boolean> {
  await current.locator.hover({ timeout: 3_000 }).catch(() => {});

  const next = page.locator(NEXT_BUTTON).first();
  if ((await next.count().catch(() => 0)) > 0) {
    await next.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(700);
    return true;
  }

  await page.keyboard.press("ArrowRight").catch(() => {});
  await page.waitForTimeout(700);
  return true;
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

    // 선택자만 기다리면 안 된다 - POST_IMAGE는 아바타에도 걸려서, 본문 사진이 로드되기 전에
    // 대기가 끝나고 곧장 "슬라이드 0장"으로 실패한다. 조건(CDN + 최소 크기)을 만족하는 사진이
    // 실제로 나타날 때까지 폴링한다.
    let ready = false;
    for (let waited = 0; waited < 30_000; waited += 1_000) {
      if (await currentPostImage(page)) {
        ready = true;
        break;
      }
      await page.waitForTimeout(1_000);
    }
    if (!ready) {
      const where = await dumpDiagnostics(page, tempDir);
      throw new Error(
        `본문 사진을 찾지 못했습니다(로그인 벽·동의 배너·레이아웃 변경 중 하나). ${where}\n` +
          `   창을 띄워 눈으로 보려면: IG_CAPTURE_HEADLESS=false npm run ig:capture -- <id> --dry-run --keep`
      );
    }

    const caption = await page
      .locator("main h1, article h1, main [data-testid='post-comment-root'] span")
      .first()
      .innerText()
      .catch(() => "");

    const slides: CarouselCapture["slides"] = [];
    const seen = new Set<string>();

    for (let i = 1; i <= maxSlides; i += 1) {
      const current = await currentPostImage(page);
      if (!current) break;

      // 같은 이미지를 두 번 찍으면(다음으로 못 넘어갔다) 거기서 멈춘다.
      if (seen.has(current.src)) break;
      seen.add(current.src);

      const localPath = join(tempDir, `slide-${i}.png`);
      await current.locator.screenshot({ path: localPath });
      slides.push({ slideIndex: i, localPath });

      if (!(await goToNextSlide(page, current))) break;
    }

    return { slides, caption: caption.trim(), tempDir };
  } finally {
    await context.close().catch(() => {});
  }
}
