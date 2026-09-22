// npm run ig:login
//
// 인스타 로그인 프로필을 만든다(맥 전용, 최초 1회).
//
// 왜 전용 명령인가: 프로필은 captureInstagramCarousel이 쓰는 것과 **완전히 같은 방식**으로
// 만들어져야 한다(chromium.launchPersistentContext + 같은 디렉터리 + 같은 launch 인자). npx
// playwright 한 줄로 만들면 인자가 어긋나 "로그인은 했는데 캡처는 로그인 안 된 상태"가 되기 쉽다.
// 여기서는 캡처와 같은 함수를 부르고 headless만 끈다.
//
// 세션이 풀리면 이 명령을 다시 돌리면 된다 - 같은 디렉터리에 덮어쓴다.
import "dotenv/config";

import { chromium } from "playwright";

import { instagramProfilePath } from "./captureInstagramCarousel.js";

async function main(): Promise<void> {
  const profile = instagramProfilePath();
  if (!profile) {
    console.error("❌ IG_BROWSER_PROFILE이 .env에 없습니다.");
    console.error("   예: IG_BROWSER_PROFILE=/Users/<사용자>/.ig-profile");
    process.exit(1);
  }

  console.log(`▶ 프로필: ${profile}`);
  console.log("▶ 창이 열리면 인스타그램에 로그인하세요. 로그인이 끝나면 이 터미널에서 Enter를 누르세요.\n");

  const context = await chromium.launchPersistentContext(profile, {
    // 캡처는 headless: true로 돌지만 프로필은 공유된다 - 여기서만 창을 띄운다.
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 1280 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });

    await new Promise<void>((resolveWait) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolveWait());
    });

    // 로그인이 실제로 됐는지 확인한다 - "창을 닫았으니 됐겠지"로 넘기면 캡처가 매 분 실패한다.
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    const loggedIn = await page
      .locator('svg[aria-label="홈"], svg[aria-label="Home"], a[href="/direct/inbox/"]')
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    if (loggedIn) {
      console.log("\n✅ 로그인이 확인됐습니다. 프로필이 저장됐습니다.");
      console.log("   이제 .env에 IG_CAPTURE_AUTO=true를 넣으면 캡처가 자동으로 돕니다.");
    } else {
      console.warn("\n⚠️ 로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요(npm run ig:login).");
      process.exitCode = 1;
    }
  } finally {
    await context.close().catch(() => {});
    process.stdin.pause();
  }
}

main().catch((error) => {
  console.error("❌ [ig-login] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
