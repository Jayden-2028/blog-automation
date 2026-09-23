// 인스타 로그인이 살아 있는지 확인한다(2026-09-23).
//
// 왜 필요한가: 캡처가 3회 실패해 포기할 때 "왜 실패했는지"를 추측으로 적으면 안 된다. 예전
// 메시지는 "로그인 만료 또는 비공개 게시물 의심"이었는데, 실측해 보니 셀렉터 문제였던 적이
// 여러 번이다(2026-09-22). 사용자에게 `npm run ig:login`을 시키려면 **실제로 풀렸을 때만**
// 시켜야 한다 - 아니면 매번 헛걸음을 하게 만든다.
//
// 확인 방법은 ig:login이 로그인 성공을 판정할 때 쓰는 것과 **같은 선택자**다. 두 곳이 어긋나면
// "로그인했다는데 또 로그인하라고 한다"가 된다.
import { chromium } from "playwright";

import { instagramProfilePath } from "./captureInstagramCarousel.js";

export type LoginState = "logged_in" | "logged_out" | "unknown";

export async function checkInstagramLogin(): Promise<LoginState> {
  const profile = instagramProfilePath();
  if (!profile) return "unknown";

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: process.env.IG_CAPTURE_HEADLESS !== "false",
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      viewport: { width: 1280, height: 1280 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "ko-KR",
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const loggedIn = await page
      .locator('svg[aria-label="홈"], svg[aria-label="Home"], a[href="/direct/inbox/"]')
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    return loggedIn ? "logged_in" : "logged_out";
  } catch {
    // 브라우저를 아예 못 띄웠으면 로그인 여부를 단정할 수 없다 - 모른다고 답한다.
    return "unknown";
  } finally {
    await context?.close().catch(() => {});
  }
}
