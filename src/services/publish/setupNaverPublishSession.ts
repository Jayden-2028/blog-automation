// 네이버 블로그 발행(쓰기) 세션 최초 설정 + 글쓰기 화면 DOM 실측(SPRINT_4_DESIGN.md §10-1).
//
// 이 스크립트가 하는 일 둘:
//   1) Creator Advisor(읽기)와 분리된 새 persistent profile에 사용자가 직접 NAVER 로그인한다
//      (결정 §9-4: "지금 진행"). 로그인 정보는 절대 이 코드가 다루지 않는다 - headless:false로
//      연 실제 브라우저 창에서 사용자가 직접 입력한다.
//   2) 로그인 후 블로그 글쓰기 화면 URL과 DOM을 스냅샷으로 남긴다. SmartEditor 셀렉터는
//      설계만으로 알 수 없고(Creator Advisor 때도 실측 후에야 확정됐다) 여기서 남긴 스냅샷을
//      다음 구현 단계(convertArticleToNaverHtml.ts, NaverBlogPublisher.ts)의 근거로 쓴다.
//
// 안전: DB/Telegram 쓰기 없음, "저장"/"발행" 버튼을 자동으로 누르지 않는다(사람이 직접 조작).
// 스냅샷은 .local/dom-snapshots/(gitignore)에만 저장한다.
//
// 실행: npm run setup:naver-publish
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

import { NAVER_PUBLISH_CONFIG } from "../../config/naverPublish.js";

const OUT_DIR = ".local/dom-snapshots/naver-publish";
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const STATE_POLL_INTERVAL_MS = 2000;
const MANUAL_NAVIGATION_TIMEOUT_MS = 10 * 60 * 1000;

function isNaverLoginUrl(url: string): boolean {
  return url.includes("nid.naver.com");
}

/** predicate가 true가 될 때까지 폴링한다(debugCreatorAdvisor.ts와 같은 패턴). */
async function pollUntil(page: Page, timeoutMs: number, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(STATE_POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * 최상위 문서 + 모든 하위 frame의 content를 각각 저장한다.
 *
 * 왜 frame까지 도는가(2026-08-28 실측에서 발견): 네이버 블로그는 최상위 문서가
 * `<iframe id="mainFrame">` 하나만 있는 frameset이고, SmartEditor는 그 mainFrame(또는 그
 * 안의 더 깊은 frame) 안에서 로드된다. `page.content()`는 최상위 문서만 직렬화하고 iframe
 * 내부는 빈 `<iframe src="...">` 태그로만 보여준다 - 실제 에디터 DOM(제목/본문/툴바 셀렉터)은
 * 프레임 각각의 content()를 따로 불러야 잡힌다.
 */
async function saveSnapshot(page: Page, label: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${OUT_DIR}/${timestamp}_${label}`;

  const html = await page.content();
  writeFileSync(`${base}.html`, html, "utf-8");
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  console.log(`   📸 스냅샷 저장: ${base}.html (+ .png)`);

  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  console.log(`   🔎 하위 frame ${frames.length}개 발견`);
  for (const [index, frame] of frames.entries()) {
    const frameUrl = frame.url();
    console.log(`      [${index}] ${frame.name() || "(이름 없음)"} - ${frameUrl}`);
    try {
      const frameHtml = await frame.content();
      const framePath = `${base}_frame${index}_${frame.name() || "unnamed"}.html`;
      writeFileSync(framePath, frameHtml, "utf-8");
      console.log(`          -> 저장됨: ${framePath} (${frameHtml.length}자)`);
    } catch (error) {
      console.log(`          -> 읽기 실패(cross-origin 등): ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function main(): Promise<void> {
  if (!NAVER_PUBLISH_CONFIG.blogId) {
    console.error("❌ CREATOR_ADVISOR_BLOG_ID가 설정되지 않았습니다(.env). 발행 대상 블로그 ID가 필요합니다.");
    process.exitCode = 1;
    return;
  }

  console.log(`profile: ${NAVER_PUBLISH_CONFIG.profileDir} (Creator Advisor 프로필과 분리된 쓰기 전용 세션)`);
  console.log(`blogId: ${NAVER_PUBLISH_CONFIG.blogId}`);
  console.log("");

  const context = await chromium.launchPersistentContext(NAVER_PUBLISH_CONFIG.profileDir, {
    headless: false,
  });

  try {
    const page = await context.newPage();
    const blogHomeUrl = `https://blog.naver.com/${NAVER_PUBLISH_CONFIG.blogId}`;
    await page.goto(blogHomeUrl, { waitUntil: "networkidle" });

    if (isNaverLoginUrl(page.url())) {
      console.log("⏳ NAVER 로그인이 필요합니다 - 브라우저에서 직접 로그인해주세요 (최대 5분 대기)");
      console.log("   (이 스크립트는 로그인 정보를 입력하지 않습니다 - 브라우저 창에서 직접 입력하세요)");
      const loggedIn = await pollUntil(page, LOGIN_WAIT_TIMEOUT_MS, () => !isNaverLoginUrl(page.url()));
      if (!loggedIn) {
        console.error("\n❌ 5분 내 로그인 완료를 확인하지 못했습니다. 스크립트를 다시 실행해주세요.");
        return;
      }
      console.log("\n✅ NAVER 로그인 성공 (세션이 프로필에 저장됐습니다 - 다음부터는 자동 재사용됩니다)");
    } else {
      console.log("✅ NAVER 로그인 이미 확인됨 (persistent profile 세션 재사용)");
    }

    await saveSnapshot(page, "blog-home");

    console.log("\n▶ 이제 브라우저에서 직접 '글쓰기' 화면으로 이동해주세요.");
    console.log("   (제목/본문에 아무것도 입력하지 마세요 - 빈 화면 구조만 살펴봅니다)");
    console.log(`   준비되면 이 터미널에서 아무 키나 누르지 말고 최대 10분 안에 이동을 마쳐주세요.`);
    console.log("   자동으로 URL 변화를 감지해 스냅샷을 남깁니다.\n");

    const startUrl = page.url();
    const navigated = await pollUntil(page, MANUAL_NAVIGATION_TIMEOUT_MS, () => page.url() !== startUrl);
    if (!navigated) {
      console.error("\n❌ 10분 내 화면 이동을 감지하지 못했습니다. 글쓰기 화면으로 이동한 뒤 다시 실행해주세요.");
      return;
    }

    // SPA 전환일 수 있어 렌더링이 안정될 시간을 조금 더 준다.
    await page.waitForTimeout(3000);
    console.log(`✅ 화면 이동 감지: ${page.url()}`);
    await saveSnapshot(page, "write-screen");

    console.log("\n▶ 완료. 스냅샷을 분석해 SmartEditor 셀렉터를 확정하는 다음 단계로 넘어갑니다.");
    console.log("   브라우저 창은 열어둔 채로 필요하면 직접 더 살펴보셔도 됩니다.");
    console.log("   이 터미널 스크립트를 종료하려면 Ctrl+C를 누르세요(로그인 세션은 프로필에 남습니다).");

    // 사용자가 화면을 계속 살펴볼 수 있게 브라우저를 바로 닫지 않고 열어둔다 - Ctrl+C로 끝낸다.
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
