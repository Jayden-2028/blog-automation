// 키노라이츠 미디어 탭의 **스틸 전체 목록**을 브라우저로 불러온다(2026-11-19).
//
// 왜 필요한가: 서버가 HTML에 실어 주는 스틸은 최대 20장이다. 나머지는 스크롤·더보기를 하면 클라이언트가
// 불러온다(건축학개론: HTML 20장 -> 브라우저 26장, 안나: 20 -> 33). 인물 글은 "그 작품에서 이 배우가 혼자 나온
// 컷"을 고르는 일이라 후보 풀이 클수록 낫다. 사용자가 손으로 하는 순서(미디어 탭 -> 더보기 -> 스틸 목록)를 그대로 따른다.
//
// api.kinolights.com/graphql을 직접 부르지 않는다 - 역설계한 API는 언제 바뀌어도 알 수 없다(searchKinolightsStills.ts).
// 사람이 쓰는 화면을 열어 DOM에서 읽는다.
//
// **실패는 null이다.** Chromium이 없거나(러너 설치 단계는 continue-on-error다) 시간이 넘으면 null을 돌려주고,
// 호출부가 서버 렌더 HTML의 20장으로 떨어진다. 예외를 던지지 않는다.
//
// 실측: 기본 헤드리스 UA(`HeadlessChrome`)는 403을 받는다. 일반 Chrome UA를 쓴다.

import { chromium } from "playwright";

import { extractStills } from "./searchKinolightsStills.js";
import type { KinolightsStill } from "./searchKinolightsStills.js";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/** 작품 하나당 페이지 로딩 예산. 넘으면 그때까지 모은 것을 쓴다. */
export const MEDIA_LOAD_BUDGET_MS = 25_000;
/** 스크롤·더보기를 반복하다 개수가 이만큼 연속으로 안 늘면 끝으로 본다. */
const STABLE_ROUNDS = 2;
const STILL_BUTTON = 'button[aria-label^="스틸컷"]';

/**
 * `https://m.kinolights.com/season/8595/media` -> 데스크톱 주소. 모바일 주소는 어차피 리다이렉트되지만
 * 한 번을 아낀다.
 */
function desktopMediaUrl(mediaUrl: string): string {
  return mediaUrl.replace("://m.kinolights.com", "://kinolights.com");
}

/**
 * 미디어 페이지를 열어 스크롤·더보기로 스틸을 끝까지 불러온 뒤 `extractStills`로 읽는다.
 * 스틸 버튼을 하나도 못 봤으면(차단·구조 변경) null - 20장 폴백을 타게 한다.
 */
export async function loadKinolightsMediaStills(
  mediaUrl: string,
  budgetMs: number = MEDIA_LOAD_BUDGET_MS
): Promise<KinolightsStill[] | null> {
  const deadline = Date.now() + budgetMs;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 900 } });
    await page.goto(desktopMediaUrl(mediaUrl), { waitUntil: "domcontentloaded", timeout: Math.max(5_000, budgetMs - 5_000) });
    await page.waitForSelector(STILL_BUTTON, { timeout: Math.max(1_000, deadline - Date.now()) });

    let best = await page.locator(STILL_BUTTON).count();
    let stable = 0;
    while (stable < STABLE_ROUNDS && Date.now() < deadline) {
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      // 더보기 버튼이 있는 구조면 누른다(없으면 스크롤만으로 불러온다 - 실측은 이쪽이었다).
      const more = page.locator("button", { hasText: /^\s*더\s*보기\s*$/ }).first();
      if ((await more.count()) > 0) await more.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(900);
      const now = await page.locator(STILL_BUTTON).count();
      if (now > best) {
        best = now;
        stable = 0;
      } else {
        stable += 1;
      }
    }

    const html = await page.content();
    const stills = extractStills(html, mediaUrl);
    return stills.length > 0 ? stills : null;
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
