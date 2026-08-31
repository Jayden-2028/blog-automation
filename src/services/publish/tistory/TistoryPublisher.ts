// 티스토리 글 1건을 "임시저장"만 하는 Playwright 클래스. SPRINT_5_DESIGN.md §11-10.
// NaverBlogPublisher.ts의 티스토리 판이지만, 티스토리 에디터가 TinyMCE(KEditor 0.9.1) 기반이라
// 본문 입력이 훨씬 단순하다 - 클립보드 합성 없이 tinymce API로 setContent 한다.
//
// 실측(2026-08-31 setup:tistory 스냅샷):
//   - 글쓰기 URL: https://{blog}.tistory.com/manage/newpost/
//   - 제목:   textarea#post-title-inp  (placeholder "제목을 입력하세요")
//   - 본문:   iframe[name="editor-tistory_ifr"] 안 body#tinymce (data-id="editor-tistory")
//             -> window.tinymce.get("editor-tistory").setContent(html)
//   - 태그:   input#tagText  (Enter로 확정)
//   - 임시저장: .btn-draft a.action  (텍스트 "임시저장"). "완료"(#publish-layer-btn)는 절대 안 누른다.
//   - 카테고리: #category-btn (지금은 안 씀 - §9-1 매핑은 publishArticleToTistory에서 이름으로)
//
// ⚠️ 아래 가설은 첫 라이브 실행(publishArticleToTistory 실측, 사용자 승인)에서 확인한다:
//   - tinymce.get("editor-tistory")가 존재하고 setContent가 반영되는지 (에디터 인스턴스 id)
//   - setContent에 넣은 외부 <img src>(Supabase 공개 URL)를 티스토리가 유지하는지, 아니면
//     저장 시 걷어내는지 (걷어내면 filechooser 업로드 경로로 전환 - 네이버 방식)
//   - "임시저장" 클릭 후 성공 신호(토스트 / "임시저장 개수" 카운트 증가 / URL 변화)
//   - 태그 입력 후 저장까지 유지되는지
// saveDraft()는 이 가설들이 틀리면 어느 stage에서 막혔는지 결과로 알려준다.

import { chromium, type Page } from "playwright";

import { TISTORY_CONFIG } from "../../../config/publishTargets.js";

export type TistoryDraftStage = "login" | "navigate" | "title" | "body" | "image" | "tags" | "save";

export type TistoryPublishImageInput = { url: string; alt?: string };

export type TistoryDraftSaveInput = {
  title: string;
  /** 완성된 본문 HTML(convertArticleToHtml 결과, <img> 포함). */
  bodyHtml: string;
  tags?: string[];
};

export type TistoryDraftSaveResult =
  | { ok: true; draftUrl: string }
  | { ok: false; stage: TistoryDraftStage; error: string };

const SELECTORS = {
  title: "#post-title-inp",
  editorIframeName: "editor-tistory_ifr",
  editorInstanceId: "editor-tistory",
  editorBody: "#tinymce",
  tagInput: "#tagText",
  saveDraftButton: ".btn-draft a.action",
  draftCount: ".btn-draft a.count",
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
        await page.waitForTimeout(2500); // KEditor/TinyMCE 초기화 대기
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

      try {
        await page.waitForSelector(SELECTORS.title, { timeout: 15_000 });
        await page.fill(SELECTORS.title, input.title);
      } catch (error) {
        return { ok: false, stage: "title", error: this.errorMessage(error) };
      }

      try {
        await this.setBody(page, input.bodyHtml);
      } catch (error) {
        return { ok: false, stage: "body", error: this.errorMessage(error) };
      }

      if (input.tags && input.tags.length > 0) {
        try {
          await this.fillTags(page, input.tags);
        } catch (error) {
          return { ok: false, stage: "tags", error: this.errorMessage(error) };
        }
      }

      try {
        const draftUrl = await this.clickSaveDraft(page);
        return { ok: true, draftUrl };
      } catch (error) {
        return { ok: false, stage: "save", error: this.errorMessage(error) };
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  /** TinyMCE API로 본문을 넣는다. 인스턴스가 없으면(가설 오류) iframe body에 직접 쓴다. */
  private async setBody(page: Page, html: string): Promise<void> {
    const viaApi = await page.evaluate(
      ({ instanceId, htmlContent }) => {
        const g: any = globalThis as any;
        const tm = g.tinymce;
        if (tm && typeof tm.get === "function") {
          const ed = tm.get(instanceId) ?? (tm.editors && tm.editors[0]);
          if (ed && typeof ed.setContent === "function") {
            ed.setContent(htmlContent);
            ed.fire?.("change");
            return true;
          }
        }
        return false;
      },
      { instanceId: SELECTORS.editorInstanceId, htmlContent: html }
    );

    if (viaApi) return;

    // 폴백: iframe body에 innerHTML 직접 주입
    const frame = page.frame({ name: SELECTORS.editorIframeName });
    if (!frame) throw new Error(`에디터 iframe(${SELECTORS.editorIframeName})을 찾지 못했습니다.`);
    await frame.evaluate(
      ({ selector, htmlContent }) => {
        const g: any = globalThis as any;
        const body = g.document.querySelector(selector);
        if (!body) throw new Error("iframe body를 찾지 못했습니다.");
        body.innerHTML = htmlContent;
      },
      { selector: SELECTORS.editorBody, htmlContent: html }
    );
  }

  private async fillTags(page: Page, tags: string[]): Promise<void> {
    await page.waitForSelector(SELECTORS.tagInput, { timeout: 5_000 });
    for (const tag of tags.slice(0, 10)) {
      await page.fill(SELECTORS.tagInput, tag);
      await page.press(SELECTORS.tagInput, "Enter");
      await page.waitForTimeout(200);
    }
  }

  /** "임시저장"만 클릭한다. "완료"/"공개 발행"은 절대 누르지 않는다. */
  private async clickSaveDraft(page: Page): Promise<string> {
    const countBefore = await this.readDraftCount(page);
    await page.click(SELECTORS.saveDraftButton);

    // 성공 신호: "임시저장 개수"가 증가하거나(가장 신뢰할 만함), 토스트가 뜨거나, 4초 경과.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const now = await this.readDraftCount(page);
      if (now > countBefore) break;
    }

    // 티스토리 임시저장은 별도 URL을 주지 않는다 - 임시저장 글 목록으로 안내한다.
    return `https://${this.blogName}.tistory.com/manage/posts/`;
  }

  private async readDraftCount(page: Page): Promise<number> {
    try {
      const label = await page.getAttribute(SELECTORS.draftCount, "aria-label");
      const m = label?.match(/(\d+)/);
      return m ? Number.parseInt(m[1], 10) : 0;
    } catch {
      return 0;
    }
  }
}
