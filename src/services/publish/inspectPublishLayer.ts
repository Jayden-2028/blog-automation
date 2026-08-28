// "발행" 설정 패널(태그/카테고리/공개설정 등) DOM 실측 전용 1회성 스크립트(SPRINT_4_DESIGN.md §10-1 후속).
//
// 배경: setupNaverPublishSession.ts로 확보한 write-screen 정적 HTML에는 태그 입력란이 없었다
// (grep 결과 tag 관련 class 0건). "발행" 버튼 옆에 `data-focus-lock="publishLayer"` wrapper만
// 존재하고 내부 패널은 클릭 전엔 DOM에 렌더링되지 않는 React 컴포넌트로 보인다.
//
// 사용자 승인(2026-08-28, "진행 - 패널만 열고 절대 더 진행하지 않겠습니다"): "발행" 버튼을 1회
// 클릭해 설정 패널을 열고 그 안의 DOM(태그 입력란 등)만 스냅샷으로 남긴다.
//
// 절대 금지: 패널이 열린 뒤 그 안의 실제 "발행"/"확인" 확정 버튼을 누르는 것. 이 스크립트는
// 패널을 연 직후 즉시 스냅샷을 저장하고 프로세스를 그대로 멈춘다(추가 클릭 없음) - 실제 발행
// 여부는 사람이 브라우저 창을 보고 직접 판단한다.
//
// 실행: npm run inspect:publish-layer
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

import { NAVER_PUBLISH_CONFIG } from "../../config/naverPublish.js";

const OUT_DIR = ".local/dom-snapshots/naver-publish";
const CATEGORY_NO = 32; // 이전 실측(setupNaverPublishSession.ts)에서 확인된 실제 글쓰기 카테고리

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
    console.error("❌ CREATOR_ADVISOR_BLOG_ID가 설정되지 않았습니다(.env).");
    process.exitCode = 1;
    return;
  }

  console.log(`profile: ${NAVER_PUBLISH_CONFIG.profileDir} (로그인 세션 재사용, 재로그인 불필요)`);
  console.log(`blogId: ${NAVER_PUBLISH_CONFIG.blogId}`);
  console.log("⚠️  이 스크립트는 '발행' 버튼을 눌러 설정 패널을 엽니다. 패널 안의 실제 발행/확인 버튼은");
  console.log("   자동으로 누르지 않습니다 - 절대 실제 발행까지 진행하지 마세요.\n");

  const context = await chromium.launchPersistentContext(NAVER_PUBLISH_CONFIG.profileDir, {
    headless: false,
  });

  try {
    const page = await context.newPage();
    const writeUrl = `https://blog.naver.com/${NAVER_PUBLISH_CONFIG.blogId}/postwrite?categoryNo=${CATEGORY_NO}`;
    await page.goto(writeUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    console.log(`현재 URL: ${page.url()}`);

    const mainFrame = page.frames().find((frame) => frame.name() === "mainFrame") ?? page.mainFrame();
    console.log(`SmartEditor frame URL: ${mainFrame.url()}`);

    const publishButton = mainFrame.locator('[data-click-area="tpb.publish"]');
    const count = await publishButton.count();
    if (count === 0) {
      console.error("❌ 발행 버튼(tpb.publish)을 찾지 못했습니다. 화면이 예상과 다를 수 있습니다.");
      await saveSnapshot(page, "publish-button-not-found");
      return;
    }

    console.log("▶ 발행 버튼 클릭 (설정 패널만 엽니다 - 실제 발행 아님)...");
    await publishButton.first().click();
    await page.waitForTimeout(2000);

    await saveSnapshot(page, "publish-layer-opened");

    console.log("\n✅ 완료. 설정 패널 DOM을 스냅샷으로 남겼습니다.");
    console.log("   ⚠️  브라우저 창에서 패널 안의 실제 '발행'/'확인' 버튼은 누르지 마세요.");
    console.log("   패널을 닫고 싶으면 브라우저에서 직접 취소/바깥 클릭하세요.");
    console.log("   이 터미널 스크립트를 종료하려면 Ctrl+C를 누르세요.");

    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
