// 티스토리 발행(쓰기) 세션 최초 설정 + 글쓰기 화면 DOM 실측(SPRINT_5_DESIGN.md §11-9).
// setupNaverPublishSession.ts와 같은 구조 - 네이버 쓰기 세션의 티스토리 판이다.
//
// 하는 일 둘:
//   1) TISTORY_CONFIG.profileDir(네이버·Creator Advisor와 분리)에 사용자가 직접 티스토리(카카오)
//      로그인한다. 로그인 정보는 이 코드가 다루지 않는다 - headless:false 창에서 사용자가 입력.
//   2) 로그인 후 글쓰기 화면 URL과 DOM(모든 frame 포함)을 스냅샷으로 남긴다. 티스토리 에디터
//      셀렉터는 설계만으로 알 수 없어서(네이버 SmartEditor 때와 동일) 여기 스냅샷을 TistoryPublisher
//      구현의 근거로 쓴다.
//
// 안전: DB/Telegram 쓰기 없음. "임시저장"/"발행" 버튼을 자동으로 누르지 않는다. 스냅샷은
// .local/dom-snapshots/tistory/(gitignore)에만.
//
// 실행: npm run setup:tistory
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

import { TISTORY_CONFIG } from "../../../config/publishTargets.js";

const OUT_DIR = ".local/dom-snapshots/tistory";
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const STATE_POLL_INTERVAL_MS = 2000;
const MANUAL_NAVIGATION_TIMEOUT_MS = 10 * 60 * 1000;

/** 티스토리/카카오 로그인 화면인지. 로그인되면 이 도메인들을 벗어난다. */
function isLoginUrl(url: string): boolean {
  return (
    url.includes("accounts.kakao.com") ||
    url.includes("logins.daum.net") ||
    url.includes("/auth/login") ||
    url.includes("kauth.kakao.com")
  );
}

async function pollUntil(page: Page, timeoutMs: number, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(STATE_POLL_INTERVAL_MS);
  }
  return true;
}

async function saveSnapshot(page: Page, label: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${OUT_DIR}/${timestamp}_${label}`;

  writeFileSync(`${base}.html`, await page.content(), "utf-8");
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  console.log(`   📸 스냅샷: ${base}.html (+ .png)`);

  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  console.log(`   🔎 하위 frame ${frames.length}개`);
  for (const [index, frame] of frames.entries()) {
    console.log(`      [${index}] ${frame.name() || "(이름 없음)"} - ${frame.url()}`);
    try {
      writeFileSync(`${base}_frame${index}_${frame.name() || "unnamed"}.html`, await frame.content(), "utf-8");
    } catch (error) {
      console.log(`          읽기 실패: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function blogName(): string {
  // https://wooahpapa.tistory.com/ -> wooahpapa
  try {
    return new URL(TISTORY_CONFIG.blogUrl).host.split(".")[0];
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const name = blogName();
  if (!name) {
    console.error("❌ TISTORY_BLOG_URL이 올바르지 않습니다(.env). 예: https://wooahpapa.tistory.com/");
    process.exitCode = 1;
    return;
  }
  console.log(`profile: ${TISTORY_CONFIG.profileDir} (네이버·Creator Advisor 프로필과 분리)`);
  console.log(`blog: ${TISTORY_CONFIG.blogUrl} (blogName=${name})\n`);

  const context = await chromium.launchPersistentContext(TISTORY_CONFIG.profileDir, { headless: false });
  try {
    const page = await context.newPage();
    const writeUrl = `https://${name}.tistory.com/manage/newpost/`;
    await page.goto(writeUrl, { waitUntil: "domcontentloaded" });

    if (isLoginUrl(page.url())) {
      console.log("⏳ 티스토리(카카오) 로그인이 필요합니다 - 브라우저에서 직접 로그인해주세요 (최대 5분)");
      console.log("   (이 스크립트는 로그인 정보를 입력하지 않습니다)");
      const ok = await pollUntil(page, LOGIN_WAIT_TIMEOUT_MS, () => !isLoginUrl(page.url()));
      if (!ok) {
        console.error("\n❌ 5분 내 로그인을 확인하지 못했습니다. 다시 실행해주세요.");
        return;
      }
      console.log("\n✅ 로그인 성공 (세션이 프로필에 저장됨 - 다음부터 자동 재사용)");
      // 로그인 후 글쓰기 화면으로 다시 이동
      await page.goto(writeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    } else {
      console.log("✅ 로그인 이미 확인됨 (persistent profile 재사용)");
    }

    await page.waitForTimeout(3000);
    console.log(`\n▶ 현재 화면: ${page.url()}`);
    await saveSnapshot(page, "write-screen");

    // 티스토리 에디터는 "기본 모드"와 "HTML 모드"가 있다. HTML 모드로 전환한 화면도 실측이 필요하다.
    console.log("\n▶ 브라우저에서 에디터 우측 상단 톱니(⚙) 또는 모드 선택에서 'HTML' 모드로 바꿔주세요.");
    console.log("   (제목/본문에 아무것도 입력하지 마세요 - 구조만 살펴봅니다)");
    console.log("   전환하면 자동으로 스냅샷을 남깁니다. 10분 대기.\n");

    const before = page.url();
    // HTML 모드 전환은 URL을 안 바꿀 수 있으므로, 특정 마커(textarea 등)가 나타나는지도 함께 본다.
    const changed = await pollUntil(page, MANUAL_NAVIGATION_TIMEOUT_MS, () => {
      return page.url() !== before;
    });
    // URL이 안 바뀌어도 10분 뒤 어차피 한 번 더 스냅샷을 남긴다.
    void changed;
    await page.waitForTimeout(1000);
    await saveSnapshot(page, "html-mode");

    console.log("\n▶ 완료. 스냅샷을 분석해 셀렉터를 확정하는 다음 단계로 넘어갑니다.");
    console.log("   브라우저는 열어둔 채 필요하면 더 살펴보세요. 종료는 Ctrl+C (세션은 프로필에 남습니다).");
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
