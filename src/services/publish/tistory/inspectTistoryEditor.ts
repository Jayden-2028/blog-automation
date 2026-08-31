// 티스토리 글쓰기 화면 DOM 실측 전용 스크립트(SPRINT_5_DESIGN.md §11-9). setup:tistory로 세션을
// 저장한 뒤 실행한다. 발행/임시저장 버튼을 절대 누르지 않고, 셀렉터 후보만 구조화해서 남긴다.
//
// 출력: .local/dom-snapshots/tistory/<timestamp>_inspect.json + 콘솔 요약.
//   - buttons: 화면의 모든 button (text / data-* / class / aria)
//   - inputs: 모든 input/textarea (type / name / placeholder / class / id)
//   - iframes: frame 목록 (에디터가 iframe 안에 있으면 그 안도 다시 훑는다)
//   - editorCandidates: contenteditable / CodeMirror / textarea 등 본문 후보
//
// 실행: npm run inspect:tistory
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Frame, type Page } from "playwright";

import { TISTORY_CONFIG } from "../../../config/publishTargets.js";

const OUT_DIR = ".local/dom-snapshots/tistory";

function isLoginUrl(url: string): boolean {
  return url.includes("accounts.kakao.com") || url.includes("/auth/login") || url.includes("kauth.kakao.com");
}

function blogName(): string {
  try {
    return new URL(TISTORY_CONFIG.blogUrl).host.split(".")[0];
  } catch {
    return "";
  }
}

// tsconfig에 "dom" lib이 없어(Node 전용) document/location을 직접 참조할 수 없다 -
// NaverBlogPublisher.ts와 같은 패턴으로 globalThis를 any로 캐스팅해 우회한다(실제로는 브라우저 안).
async function probeContext(target: Page | Frame, label: string): Promise<unknown> {
  try {
    const data = await target.evaluate(() => {
      const g: any = globalThis as any;
      const d = g.document;
      const pick = (el: any) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || "").trim().slice(0, 40),
        id: el.id || null,
        name: el.getAttribute("name") || null,
        type: el.getAttribute("type") || null,
        placeholder: el.getAttribute("placeholder") || null,
        cls: typeof el.className === "string" ? el.className.slice(0, 120) : null,
        data: Object.fromEntries(
          [...el.attributes]
            .filter((a: any) => a.name.startsWith("data-") || a.name.startsWith("aria-"))
            .map((a: any) => [a.name, a.value.slice(0, 60)])
        ),
      });
      return {
        url: g.location.href,
        title: d.title,
        buttons: [...d.querySelectorAll('button, [role="button"], a.btn')].map(pick).slice(0, 120),
        inputs: [...d.querySelectorAll("input, textarea")].map(pick).slice(0, 60),
        editorCandidates: [
          ...d.querySelectorAll(
            '[contenteditable="true"], .CodeMirror, .cm-editor, textarea, .mce-content-body, #editorContainer, [data-editor]'
          ),
        ]
          .map(pick)
          .slice(0, 40),
        iframeSrcs: [...d.querySelectorAll("iframe")].map((f: any) => ({
          src: f.src,
          id: f.id,
          name: f.name,
          cls: (f.className || "").slice(0, 80),
        })),
      };
    });
    return { label, ...data };
  } catch (error) {
    return { label, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const name = blogName();
  if (!name) {
    console.error("❌ TISTORY_BLOG_URL이 올바르지 않습니다(.env).");
    process.exitCode = 1;
    return;
  }

  const context = await chromium.launchPersistentContext(TISTORY_CONFIG.profileDir, { headless: false });
  try {
    const page = await context.newPage();
    await page.goto(`https://${name}.tistory.com/manage/newpost/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    if (isLoginUrl(page.url())) {
      console.error("❌ 로그인이 안 되어 있습니다. 먼저 `npm run setup:tistory`로 로그인하세요.");
      return;
    }

    const report: Record<string, unknown> = { probedAt: new Date().toISOString(), writeUrl: page.url() };
    report.main = await probeContext(page, "main");

    const frames = page.frames().filter((f) => f !== page.mainFrame());
    report.frames = [];
    for (const [i, frame] of frames.entries()) {
      (report.frames as unknown[]).push(await probeContext(frame, `frame[${i}] ${frame.name() || frame.url()}`));
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const path = `${OUT_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}_inspect.json`;
    writeFileSync(path, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\n✅ 저장: ${path}`);

    // 콘솔 요약: 본문 후보 + '임시저장'/'저장' 텍스트 버튼
    const m = report.main as { editorCandidates?: Array<{ tag: string; cls: string | null }>; buttons?: Array<{ text: string; cls: string | null; data: Record<string, string> }> };
    console.log("\n본문 후보:");
    for (const c of m.editorCandidates ?? []) console.log(`  ${c.tag} .${(c.cls ?? "").split(" ")[0]}`);
    console.log("\n저장/발행 관련 버튼:");
    for (const b of m.buttons ?? []) {
      if (/저장|발행|임시|공개|완료|publish|save/i.test(b.text)) {
        console.log(`  "${b.text}"  .${(b.cls ?? "").split(" ")[0]}  ${JSON.stringify(b.data)}`);
      }
    }

    console.log("\n브라우저는 열어둡니다. 종료는 Ctrl+C.");
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
