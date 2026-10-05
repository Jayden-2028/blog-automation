// 티스토리 발행 세션 설정 + 글쓰기·발행 레이어 DOM 실측(TISTORY_AUTO_PUBLISH_DESIGN.md §6 0단계).
// setupNaverPublishSession.ts와 같은 구조. 2026-09-15에 지웠던 것을 2026-10-06에 되살리며 발행 레이어
// 실측을 더했다 - 옛 실측(2026-08-31)은 임시저장까지만 봤고, 이번에는 **실제 발행**(공개 범위·카테고리·발행
// 버튼)과 **이미지 업로드**(파일 입력)가 필요하다.
//
// 하는 일:
//   1) TISTORY_CONFIG.profileDir에 사용자가 직접 카카오 로그인한다(headless:false 창). 로그인 정보는 이 코드가
//      다루지 않는다.
//   2) 글쓰기 화면을 스냅샷(모든 frame + 파일 입력·툴바·tinymce 인스턴스 요약).
//   3) 사용자가 "완료"를 눌러 발행 레이어를 **열기만** 하면(발행 버튼은 누르지 않는다) 새로 보이는 요소를 감지해
//      레이어를 스냅샷(공개 범위 선택지·카테고리 목록·버튼 문구).
//
// 안전: DB/Telegram 쓰기 없음. 이 스크립트는 어떤 버튼도 자동으로 누르지 않는다. 스냅샷은
// .local/dom-snapshots/tistory/(gitignore)에만 남는다.
//
// 실행: npm run setup:tistory                (실측 포함)
//       npm run setup:tistory -- --login-only  (운영 재로그인: 로그인만 하고 자동 종료)
// 맥미니에서 돌리면 그 프로필에 세션이 남아 폴러가 쓴다. 카카오 "로그인 상태 유지"를 켜야 세션이 오래 간다.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

import { TISTORY_CONFIG, tistoryBlogName } from "../../../config/publishTargets.js";

const OUT_DIR = ".local/dom-snapshots/tistory";
const LOGIN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const LAYER_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

/** 티스토리/카카오 로그인 화면인지. 로그인되면 이 도메인들을 벗어난다. */
export function isTistoryLoginUrl(url: string): boolean {
  return (
    url.includes("accounts.kakao.com") ||
    url.includes("logins.daum.net") ||
    url.includes("/auth/login") ||
    url.includes("kauth.kakao.com")
  );
}

async function pollUntil(page: Page, timeoutMs: number, predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return true;
}

// page.evaluate에 넘기는 코드는 **문자열**로 둔다. tsx(esbuild)가 화살표 함수에 `__name(...)` 보조 호출을
// 끼워 넣는데 그 함수가 브라우저에는 없어 "ReferenceError: __name is not defined"로 죽는다(2026-10-06 실측).
const VISIBLE_CONTROL_TEXTS_JS = `(() => {
  const out = [];
  document.querySelectorAll("button, a, label, [role=button], [role=radio], [role=tab]").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    if (text) out.push(text.slice(0, 40));
  });
  return out;
})()`;

const SUMMARY_JS = `(() => {
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const describe = (e) => {
    const attrs = ["id", "name", "class", "type", "accept", "aria-label", "placeholder", "data-id"]
      .map((a) => (e.getAttribute(a) ? a + '="' + e.getAttribute(a) + '"' : ""))
      .filter(Boolean)
      .join(" ");
    const rect = e.getBoundingClientRect();
    return "<" + e.tagName.toLowerCase() + " " + attrs + "> visible=" + (rect.width > 0 && rect.height > 0)
      + ' text="' + (e.innerText || "").trim().slice(0, 30) + '"';
  };
  const t = window.tinymce;
  return {
    url: location.href,
    fileInputs: q("input[type=file]").map(describe),
    titleCandidates: q("textarea, input[type=text]").slice(0, 10).map(describe),
    iframes: q("iframe").map(describe),
    toolbarButtons: q("button, [role=button]").filter((el) => el.getBoundingClientRect().width > 0).slice(0, 80).map(describe),
    selects: q("select").map((el) => describe(el) + " options=[" + Array.from(el.options).map((o) => o.value + ":" + o.text.trim()).join(", ") + "]"),
    radios: q("input[type=radio], [role=radio]").map(describe),
    tinymce: t ? "window.tinymce 있음, editors=[" + (t.editors || []).map((e) => e.id).join(", ") + "]" : "window.tinymce 없음",
    modeControls: q("[class*=mode], [id*=mode]").slice(0, 10).map(describe),
  };
})()`;

/** 지금 화면에 보이는 버튼·라벨·링크 문구(발행 레이어가 열리면 새 문구가 나타난다). */
async function visibleControlTexts(page: Page): Promise<string[]> {
  return page.evaluate(VISIBLE_CONTROL_TEXTS_JS) as Promise<string[]>;
}

/** 발행기 구현에 바로 쓸 요약 - 스냅샷 HTML을 다 읽지 않아도 핵심 셀렉터가 보이게. */
async function summarize(page: Page): Promise<string> {
  return JSON.stringify(await page.evaluate(SUMMARY_JS), null, 2);
}

async function saveSnapshot(page: Page, label: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${OUT_DIR}/${timestamp}_${label}`;

  writeFileSync(`${base}.html`, await page.content(), "utf-8");
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  writeFileSync(`${base}_summary.json`, await summarize(page), "utf-8");
  console.log(`   📸 스냅샷: ${base}.html / .png / _summary.json`);

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

async function main(): Promise<void> {
  const name = tistoryBlogName();
  if (!name) {
    console.error("❌ TISTORY_BLOG_URL이 올바르지 않습니다(.env). 예: https://wooahpapa.tistory.com/");
    process.exitCode = 1;
    return;
  }
  console.log(`profile: ${TISTORY_CONFIG.profileDir}`);
  console.log(`blog: ${TISTORY_CONFIG.blogUrl} (blogName=${name})\n`);

  const context = await chromium.launchPersistentContext(TISTORY_CONFIG.profileDir, { headless: false });
  try {
    const page = await context.newPage();
    const writeUrl = `https://${name}.tistory.com/manage/newpost/`;
    await page.goto(writeUrl, { waitUntil: "domcontentloaded" });

    if (isTistoryLoginUrl(page.url())) {
      console.log("⏳ 티스토리(카카오) 로그인이 필요합니다 - 브라우저 창에서 직접 로그인해주세요 (최대 10분)");
      console.log("   '로그인 상태 유지'가 있으면 켜 주세요. 이 스크립트는 로그인 정보를 입력하지 않습니다.");
      const ok = await pollUntil(page, LOGIN_WAIT_TIMEOUT_MS, () => !isTistoryLoginUrl(page.url()));
      if (!ok) {
        console.error("\n❌ 10분 내 로그인을 확인하지 못했습니다. 다시 실행해주세요.");
        return;
      }
      console.log("\n✅ 로그인 성공 (세션이 프로필에 저장됨 - 다음부터 자동 재사용)");
      await page.goto(writeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    } else {
      console.log("✅ 로그인 이미 확인됨 (persistent profile 재사용)");
    }

    await page.waitForTimeout(4000);
    console.log(`\n▶ 현재 화면: ${page.url()}`);
    await saveSnapshot(page, "write-screen");

    if (process.argv.includes("--login-only")) {
      // 운영 재로그인 전용(실측 스냅샷 불필요). 로그인만 확인하고 바로 닫는다.
      console.log("\n▶ --login-only: 실측 없이 로그인 세션만 저장합니다. 5초 뒤 브라우저를 닫습니다.");
      await page.waitForTimeout(5_000);
      return;
    }

    const before = new Set(await visibleControlTexts(page));
    console.log("\n▶ 이제 브라우저에서 에디터 오른쪽 위 **[완료]** 버튼을 눌러 발행 설정 레이어를 열어주세요.");
    console.log("   ⚠️ 레이어 안의 발행/저장 버튼은 누르지 마세요. 열기만 하면 자동으로 스냅샷을 남깁니다 (10분 대기).");
    console.log("   제목·본문은 비워 둬도 됩니다 (비어 있다고 레이어가 안 열리면 제목에 '테스트'만 적어주세요).\n");

    const opened = await pollUntil(page, LAYER_WAIT_TIMEOUT_MS, async () => {
      const now = await visibleControlTexts(page);
      const fresh = now.filter((t) => !before.has(t));
      return fresh.some((t) => /발행|공개|비공개|보호/.test(t));
    });
    if (!opened) console.log("⚠️ 10분 안에 발행 레이어를 감지하지 못했습니다 - 현재 화면을 그대로 남깁니다.");
    await page.waitForTimeout(1500);
    await saveSnapshot(page, opened ? "publish-layer" : "timeout");

    // 스스로 닫는다(2026-10-06). 전에는 Ctrl+C를 기다렸는데, 화면 공유에서는 Ctrl+C가 안 먹어 프로세스를 강제 종료했고
    // 그러면 브라우저가 정상 종료되지 않아 **로그인 쿠키가 프로필에 저장되지 않았다**(맥미니 실측). 세션은 context.close()로
    // 깔끔하게 닫혀야 다음 실행(폴러)이 이어받는다.
    console.log("\n▶ 완료. 레이어를 취소로 닫고 10초 뒤 브라우저를 자동으로 닫습니다 (세션은 프로필에 저장됩니다).");
    await page.waitForTimeout(10_000);
    await page.keyboard.press("Escape").catch(() => {});
  } finally {
    await context.close().catch(() => {});
    console.log("✅ 브라우저를 닫았습니다. 로그인 세션 저장 완료 - 폴러가 이 세션으로 발행합니다.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
