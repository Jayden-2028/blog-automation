// 티스토리 임시저장 라이브 실측 + 진단(1회). 사용자 승인 후 수동 실행. headless:false.
// TistoryPublisher를 그대로 쓰지 않고 단계별로 직접 실행하면서 각 단계의 실제 상태를 찍는다 -
// 1차 실측에서 saveDraft가 ok를 냈는데 임시저장 글이 안 생겼기 때문(원인 진단용).
//
// 실행: npx tsx src/services/publish/tistory/liveTistoryTest.ts <jobId>
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

import { TISTORY_CONFIG } from "../../../config/publishTargets.js";
import { listArticlesByJobId } from "../../supabase/repositories/articleRepository.js";
import { convertArticleToHtml } from "../convertArticleToHtml.js";
import { TelegramNotifier } from "../../../notifications/TelegramNotifier.js";
import { TistoryPublisher } from "./TistoryPublisher.js";

const OUT_DIR = ".local/dom-snapshots/tistory";

function blogName(): string {
  return new URL(TISTORY_CONFIG.blogUrl).host.split(".")[0];
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("사용법: npx tsx src/services/publish/tistory/liveTistoryTest.ts <jobId>");
    process.exit(1);
  }

  const articles = await listArticlesByJobId(jobId);
  const base = [...articles].reverse().find((a) => a.platform == null);
  if (!base) {
    console.error(`job ${jobId}에 기준 원고가 없습니다.`);
    process.exit(1);
  }
  const title = `[실측] ${base.title ?? jobId}`;
  const bodyHtml = convertArticleToHtml(base.content ?? "");
  console.log(`▶ 대상: "${title}"  본문 ${bodyHtml.length}자, <img> ${(bodyHtml.match(/<img /g) ?? []).length}개\n`);

  // --via-publisher: 진단 대신 실제 TistoryPublisher.saveDraft를 그대로 호출한다(최종 검증).
  if (process.argv.includes("--via-publisher")) {
    const started = Date.now();
    const result = await new TistoryPublisher({ headless: false }).saveDraft({ title, bodyHtml, tags: ["실측"] });
    console.log(`\n▶ saveDraft 결과 (${Math.round((Date.now() - started) / 1000)}초):`);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok) {
      await TelegramNotifier.fromEnv()
        .sendMessages([
          {
            text: `🧪 <b>티스토리 saveDraft 최종 검증 OK</b>\n본문 ${result.bodyLength ?? "?"}자\n${result.draftUrl}`,
            replyMarkup: { inline_keyboard: [[{ text: "임시저장 글 열기", url: result.draftUrl }]] },
          },
        ])
        .catch(() => {});
      console.log("\n✅ 텔레그램 알림 발송. 임시저장 글을 열어 제목/본문/이미지/태그를 확인하세요.");
    } else {
      console.error(`\n❌ [${result.stage}] ${result.error}`);
      process.exitCode = 1;
    }
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const diag: Record<string, unknown> = { jobId, title };

  const context = await chromium.launchPersistentContext(TISTORY_CONFIG.profileDir, { headless: false });
  const page = await context.newPage();

  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(`${r.method()} ${r.url()}`);
  });

  const writeUrl = `https://${blogName()}.tistory.com/manage/newpost/`;
  await page.goto(writeUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  console.log(`1) 글쓰기 화면: ${page.url()}`);
  if (/kakao|\/auth\/login/.test(page.url())) {
    console.error("   ❌ 로그인 안 됨. npm run setup:tistory 먼저.");
    await context.close();
    process.exit(1);
  }

  // 복구 팝업 닫기
  for (const label of ["새로 작성", "취소", "아니오", "닫기"]) {
    const b = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
    if (await b.isVisible().catch(() => false)) {
      console.log(`   복구 팝업 감지 -> "${label}" 클릭`);
      await b.click().catch(() => {});
      await page.waitForTimeout(500);
      break;
    }
  }

  // tinymce 상태
  const tmState = await page.evaluate(() => {
    const g: any = globalThis as any;
    const tm = g.tinymce;
    if (!tm) return { hasTinymce: false };
    return {
      hasTinymce: true,
      editorIds: (tm.editors || []).map((e: any) => e.id),
      getByExpectedId: !!tm.get("editor-tistory"),
      initialized: (tm.editors || []).map((e: any) => ({ id: e.id, initialized: e.initialized })),
    };
  });
  diag.tinymce = tmState;
  console.log(`2) tinymce: ${JSON.stringify(tmState)}`);

  // 제목
  await page.fill("#post-title-inp", title).catch((e) => console.log(`   제목 fill 오류: ${e}`));
  const titleVal = await page.inputValue("#post-title-inp").catch(() => "(읽기 실패)");
  console.log(`3) 제목 readback: "${titleVal.slice(0, 50)}"`);
  diag.titleReadback = titleVal;

  // 본문 (tinymce API)
  const bodyResult = await page.evaluate((html) => {
    const g: any = globalThis as any;
    const tm = g.tinymce;
    const ed = tm?.get("editor-tistory") ?? (tm?.editors && tm.editors[0]);
    if (!ed) return { ok: false, reason: "no editor instance" };
    ed.setContent(html);
    ed.setDirty?.(true);
    ed.fire?.("change");
    ed.fire?.("input");
    return { ok: true, contentLength: (ed.getContent() || "").length, isDirty: ed.isDirty?.() };
  }, bodyHtml);
  diag.body = bodyResult;
  console.log(`4) 본문 setContent: ${JSON.stringify(bodyResult)}`);

  // 태그
  if (await page.locator("#tagText").isVisible().catch(() => false)) {
    await page.fill("#tagText", "실측");
    await page.press("#tagText", "Enter");
    await page.waitForTimeout(300);
    console.log("5) 태그 '실측' 입력");
  }

  await page.screenshot({ path: `${OUT_DIR}/${stamp}_before-save.png`, fullPage: true }).catch(() => {});

  // 임시저장 버튼 탐색
  const btnCandidates = await page.evaluate(() => {
    const g: any = globalThis as any;
    const out: any[] = [];
    for (const el of g.document.querySelectorAll('a, button, [role="button"]')) {
      const t = (el.innerText || "").trim();
      if (/임시저장|저장/.test(t) && t.length < 12) {
        const rect = el.getBoundingClientRect();
        out.push({ text: t, tag: el.tagName, cls: (el.className || "").slice(0, 80), id: el.id, visible: rect.width > 0 && rect.height > 0 });
      }
    }
    return out;
  });
  diag.saveButtonCandidates = btnCandidates;
  console.log(`6) 저장 버튼 후보: ${JSON.stringify(btnCandidates)}`);

  posts.length = 0;
  const saveBtn = page.locator('.btn-draft a.action, a[role="button"]:has-text("임시저장"), button:has-text("임시저장")').first();
  if (await saveBtn.isVisible().catch(() => false)) {
    console.log("7) '임시저장' 클릭...");
    await saveBtn.click();
    await page.waitForTimeout(5000);
  } else {
    console.log("7) ❌ '임시저장' 버튼이 안 보임");
  }
  diag.postRequestsAfterSave = [...posts];
  console.log(`8) 저장 후 POST 요청: ${JSON.stringify(posts, null, 1)}`);

  await page.screenshot({ path: `${OUT_DIR}/${stamp}_after-save.png`, fullPage: true }).catch(() => {});

  // 임시저장 개수 재확인
  const draftCount = await page.evaluate(() => {
    const g: any = globalThis as any;
    const el = g.document.querySelector('.btn-draft a.count, [aria-label*="임시저장 개수"]');
    return el ? (el.getAttribute("aria-label") || el.innerText) : "(못 찾음)";
  });
  diag.draftCountAfter = draftCount;
  console.log(`9) 임시저장 개수: ${draftCount}`);

  writeFileSync(`${OUT_DIR}/${stamp}_live-diag.json`, JSON.stringify(diag, null, 2), "utf-8");
  console.log(`\n✅ 진단 저장: ${OUT_DIR}/${stamp}_live-diag.json (+ before/after 스크린샷)`);

  await TelegramNotifier.fromEnv()
    .sendMessages([{ text: `🧪 티스토리 실측 진단 완료 - 본문 ${bodyResult.ok ? (bodyResult as any).contentLength : 0}자, 저장 POST ${posts.length}건. 로그/스냅샷 확인.` }])
    .catch(() => {});

  console.log("\n브라우저는 열어둡니다. 임시저장 글 목록을 직접 확인해보세요. 종료는 Ctrl+C.");
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
