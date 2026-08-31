// 티스토리 글 1건을 "임시저장"만 하는 Playwright 클래스. SPRINT_5_DESIGN.md §11-10.
// NaverBlogPublisher.ts의 티스토리 판. 티스토리 에디터는 KEditor 0.9.1(TinyMCE) 기반이라
// 본문 입력이 tinymce API로 단순하다.
//
// 실측(2026-08-31 setup:tistory 스냅샷):
//   - 글쓰기 URL: https://{blog}.tistory.com/manage/newpost/
//   - 제목:   textarea#post-title-inp
//   - 본문:   iframe[name="editor-tistory_ifr"] 안 body#tinymce (data-id="editor-tistory")
//             -> window.tinymce.get("editor-tistory").setContent(html)
//   - 태그:   input#tagText  (Enter로 확정)
//   - 임시저장: .btn-draft a.action  (텍스트 "임시저장"). "완료"(#publish-layer-btn)는 절대 안 누른다.
//
// 이 클래스는 각 단계 후 값을 되읽어 실제 반영 여부를 확인한다 - "조용히 잘못된 성공"을 내지 않는다.
// 1차 실측(2026-08-31)에서 saveDraft가 ok를 반환했는데 실제 임시저장 글이 안 생겼다: 저장
// 확인 신호를 안 보고 고정 시간만 기다린 게 원인이었다. 이제 저장은 토스트/네트워크/카운트 중
// 하나라도 확인돼야 ok다.

import { chromium, type Frame, type Page } from "playwright";

import { TISTORY_CONFIG } from "../../../config/publishTargets.js";

export type TistoryDraftStage = "login" | "navigate" | "editor-init" | "title" | "body" | "tags" | "save";

export type TistoryPublishImageInput = { url: string; alt?: string };

export type TistoryDraftSaveInput = {
  title: string;
  bodyHtml: string;
  tags?: string[];
};

export type TistoryDraftSaveResult =
  | { ok: true; draftUrl: string; bodyLength?: number }
  | { ok: false; stage: TistoryDraftStage; error: string };

const SELECTORS = {
  title: "#post-title-inp",
  editorIframeName: "editor-tistory_ifr",
  editorInstanceId: "editor-tistory",
  editorBody: "#tinymce",
  tagInput: "#tagText",
} as const;

export type TistoryPublisherOptions = {
  blogUrl?: string;
  profileDir?: string;
  headless?: boolean;
};

export class TistoryPublisher {
  private readonly blogName: string;
  private readonly profileDir: string;
  private readonly headless: boolean;

  constructor(options: TistoryPublisherOptions = {}) {
    const blogUrl = options.blogUrl ?? TISTORY_CONFIG.blogUrl;
    try {
      this.blogName = new URL(blogUrl).host.split(".")[0];
    } catch {
      throw new Error(`TISTORY_BLOG_URL이 올바르지 않습니다: ${blogUrl}`);
    }
    if (!this.blogName) throw new Error("티스토리 blogName을 확인할 수 없습니다.");
    this.profileDir = options.profileDir ?? TISTORY_CONFIG.profileDir;
    this.headless = options.headless ?? true;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async saveDraft(input: TistoryDraftSaveInput): Promise<TistoryDraftSaveResult> {
    const context = await chromium.launchPersistentContext(this.profileDir, { headless: this.headless });
    try {
      const page = await context.newPage();
      const writeUrl = `https://${this.blogName}.tistory.com/manage/newpost/`;

      try {
        await page.goto(writeUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        return { ok: false, stage: "navigate", error: this.errorMessage(error) };
      }

      if (/accounts\.kakao\.com|kauth\.kakao\.com|\/auth\/login/.test(page.url())) {
        return {
          ok: false,
          stage: "login",
          error: '티스토리(카카오) 로그인이 필요합니다. "npm run setup:tistory"로 재로그인하세요.',
        };
      }

      // "저장하지 않은 글" 복구 팝업이 뜨면 새 글로 시작한다(이전 실측 잔재 방지).
      await this.dismissRestorePopup(page);

      // TinyMCE 인스턴스가 초기화될 때까지 기다린다.
      const editorReady = await this.waitForEditor(page);
      if (!editorReady.ok) return { ok: false, stage: "editor-init", error: editorReady.error };

      // 제목
      try {
        await page.waitForSelector(SELECTORS.title, { timeout: 15_000 });
        await page.fill(SELECTORS.title, input.title);
        const titleValue = await page.inputValue(SELECTORS.title);
        if (titleValue.trim() !== input.title.trim()) {
          return { ok: false, stage: "title", error: `제목 반영 확인 실패 (읽은 값: "${titleValue.slice(0, 40)}")` };
        }
      } catch (error) {
        return { ok: false, stage: "title", error: this.errorMessage(error) };
      }

      // 본문
      let bodyLength = 0;
      try {
        bodyLength = await this.setBody(page, input.bodyHtml);
        if (bodyLength < 100) {
          return { ok: false, stage: "body", error: `본문 반영 확인 실패 (setContent 후 길이 ${bodyLength})` };
        }
      } catch (error) {
        return { ok: false, stage: "body", error: this.errorMessage(error) };
      }

      // 태그
      if (input.tags && input.tags.length > 0) {
        try {
          await this.fillTags(page, input.tags);
        } catch (error) {
          return { ok: false, stage: "tags", error: this.errorMessage(error) };
        }
      }

      // 임시저장 (검증 포함)
      try {
        const saved = await this.clickSaveDraft(page);
        if (!saved.ok) return { ok: false, stage: "save", error: saved.error };
        return { ok: true, draftUrl: saved.draftUrl, bodyLength };
      } catch (error) {
        return { ok: false, stage: "save", error: this.errorMessage(error) };
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async dismissRestorePopup(page: Page): Promise<void> {
    // 티스토리는 "작성 중이던 글이 있습니다. 이어서 작성할까요?" 팝업을 띄운다. "새로 작성" 쪽을 누른다.
    for (const label of ["새로 작성", "취소", "아니오", "닫기"]) {
      const btn = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    }
  }

  private async waitForEditor(page: Page): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await page
        .evaluate((instanceId) => {
          const g: any = globalThis as any;
          const tm = g.tinymce;
          if (!tm) return "no-tinymce";
          const ed = tm.get(instanceId) ?? (tm.editors && tm.editors[0]);
          if (!ed) return "no-editor";
          return ed.initialized ? "ready" : "initializing";
        }, SELECTORS.editorInstanceId)
        .catch(() => "error");
      if (state === "ready") return { ok: true };
      await page.waitForTimeout(500);
    }
    return { ok: false, error: "TinyMCE 에디터가 20초 내 초기화되지 않았습니다." };
  }

  /** TinyMCE API로 본문을 넣고, 되읽어 실제 길이를 반환한다. */
  private async setBody(page: Page, html: string): Promise<number> {
    const length = await page.evaluate(
      ({ instanceId, htmlContent }) => {
        const g: any = globalThis as any;
        const tm = g.tinymce;
        const ed = tm?.get(instanceId) ?? (tm?.editors && tm.editors[0]);
        if (!ed || typeof ed.setContent !== "function") return -1;
        ed.setContent(htmlContent);
        ed.undoManager?.add?.();
        ed.setDirty?.(true);
        ed.fire?.("change");
        ed.fire?.("input");
        return (ed.getContent() || "").length;
      },
      { instanceId: SELECTORS.editorInstanceId, htmlContent: html }
    );
    if (length >= 0) return length;

    // 폴백: iframe body innerHTML 직접 주입
    const frame: Frame | null = page.frame({ name: SELECTORS.editorIframeName });
    if (!frame) throw new Error(`에디터 iframe(${SELECTORS.editorIframeName})을 찾지 못했습니다.`);
    return frame.evaluate(
      ({ selector, htmlContent }) => {
        const g: any = globalThis as any;
        const body = g.document.querySelector(selector);
        if (!body) throw new Error("iframe body를 찾지 못했습니다.");
        body.innerHTML = htmlContent;
        return body.innerHTML.length;
      },
      { selector: SELECTORS.editorBody, htmlContent: html }
    );
  }

  private async fillTags(page: Page, tags: string[]): Promise<void> {
    if (!(await page.locator(SELECTORS.tagInput).isVisible().catch(() => false))) return;
    for (const tag of tags.slice(0, 10)) {
      await page.fill(SELECTORS.tagInput, tag);
      await page.press(SELECTORS.tagInput, "Enter");
      await page.waitForTimeout(250);
    }
  }

  /**
   * "임시저장"만 클릭하고, 실제 저장됐는지 확인한다.
   * 실측(2026-08-31): "임시저장" 클릭 시 POST https://{blog}.tistory.com/manage/drafts 가 발생한다.
   * 이 응답(200)을 저장 성공 신호로 쓰고, 응답 본문에서 draft id를 뽑아 재편집 URL을 만든다.
   * 응답을 못 잡으면 "임시저장 개수" 증가로 폴백하고, 그것도 없으면 ok:false.
   */
  private async clickSaveDraft(page: Page): Promise<{ ok: true; draftUrl: string } | { ok: false; error: string }> {
    const button = page
      .locator('.btn-draft a.action, .btn-draft button, a[role="button"]:has-text("임시저장"), button:has-text("임시저장")')
      .first();
    if (!(await button.isVisible().catch(() => false))) {
      return { ok: false, error: '"임시저장" 버튼을 찾지 못했습니다(셀렉터 확인 필요).' };
    }

    const countBefore = await this.readDraftCount(page);

    const savePromise = page
      .waitForResponse(
        (res) =>
          /\/manage\/drafts?(\?|$|\/)/i.test(res.url()) &&
          res.request().method() === "POST" &&
          res.status() >= 200 &&
          res.status() < 400,
        { timeout: 15_000 }
      )
      .then(async (res) => {
        const body = await res.text().catch(() => "");
        // {"entryId": 123} / {"id": 123} / {"data":{"id":123}} 등 형태를 넓게 잡는다.
        const m = body.match(/"(?:entryId|id|postId|draftId)"\s*:\s*"?(\d{2,})"?/);
        return { hit: true as const, draftId: m ? m[1] : null };
      })
      .catch(() => ({ hit: false as const, draftId: null }));

    await button.click();

    const countConfirmed = (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(700);
        if ((await this.readDraftCount(page)) > countBefore) return true;
      }
      return false;
    })();

    const [saveRes, countUp] = await Promise.all([savePromise, countConfirmed]);

    if (!saveRes.hit && !countUp) {
      return { ok: false, error: "임시저장 확인 신호(POST /manage/drafts 응답 / 임시저장 개수 증가)를 15초 내 감지하지 못했습니다." };
    }

    const draftUrl = saveRes.draftId
      ? `https://${this.blogName}.tistory.com/manage/newpost/${saveRes.draftId}`
      : `https://${this.blogName}.tistory.com/manage/posts/`;
    return { ok: true, draftUrl };
  }

  private async readDraftCount(page: Page): Promise<number> {
    for (const sel of ['.btn-draft a.count', '[aria-label*="임시저장 개수"]', ".btn-draft .count"]) {
      try {
        const el = page.locator(sel).first();
        const label = (await el.getAttribute("aria-label")) ?? (await el.innerText().catch(() => ""));
        const m = label?.match(/(\d+)/);
        if (m) return Number.parseInt(m[1], 10);
      } catch {
        // 다음 셀렉터 시도
      }
    }
    return 0;
  }
}
