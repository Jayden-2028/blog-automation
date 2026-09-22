// npm run ig:lens-login
//
// 구글 렌즈용 로그인 프로필을 만든다(맥 전용, 최초 1회). ig:login과 같은 구조다.
//
// 왜 로그인이 필요한가: lens.google.com은 자동화 트래픽에 CAPTCHA(/sorry/index)를 띄운다.
// 2026-09-23 실측에서 헤드리스를 꺼도 막혔다. 로그인된 프로필이 유일하게 남은 무료 우회다.
// 보장은 없다 - 그래도 막히면 리버스 검색을 건너뛰고 텍스트 검색(2-a)으로 떨어진다.
//
// 프로필은 인스타와 **분리한다**. 한 프로필에 두 서비스를 섞으면 한쪽이 세션을 잃었을 때
// 다른 쪽까지 다시 만들어야 한다.
import "dotenv/config";

import { chromium } from "playwright";

import { lensProfilePath } from "./reverseImageSearch.js";

async function main(): Promise<void> {
  const profile = lensProfilePath();
  if (!profile) {
    console.error("❌ LENS_BROWSER_PROFILE이 .env에 없습니다.");
    console.error("   예: LENS_BROWSER_PROFILE=/Users/<사용자>/.lens-profile");
    process.exit(1);
  }

  console.log(`▶ 프로필: ${profile}`);
  console.log("▶ 창이 열리면 구글에 로그인하세요. 끝나면 이 터미널에서 Enter를 누르세요.\n");

  const context = await chromium.launchPersistentContext(profile, {
    // 리버스 검색은 headless로 돌지만 프로필은 공유된다 - 여기서만 창을 띄운다.
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "ko-KR",
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });

    await new Promise<void>((resolveWait) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolveWait());
    });

    // 로그인됐는지 확인한다. "창을 닫았으니 됐겠지"로 넘기면 매번 CAPTCHA를 맞고도 이유를 모른다.
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded" });
    const loggedIn = !page.url().includes("accounts.google.com/signin");

    if (!loggedIn) {
      console.warn("\n⚠️ 로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요(npm run ig:lens-login).");
      process.exitCode = 1;
      return;
    }

    console.log("\n✅ 로그인이 확인됐습니다. 프로필이 저장됐습니다.");
    console.log("   .env에 LENS_REVERSE_SEARCH=true를 넣으면 대체 이미지를 리버스 검색으로 먼저 찾습니다.");
    console.log("   막히면(CAPTCHA) 자동으로 기존 텍스트 검색으로 떨어지므로 파이프라인은 멈추지 않습니다.");
  } finally {
    await context.close().catch(() => {});
    process.stdin.pause();
  }
}

main().catch((error) => {
  console.error("❌ [ig-lens-login] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
