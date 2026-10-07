// 티스토리 글 1건을 **실제 발행**하는 Playwright 클래스(TISTORY_AUTO_PUBLISH_DESIGN.md). NaverBlogPublisher.ts의
// 티스토리 판. 2026-09-15에 지운 옛 클래스(임시저장까지만)를 2026-10-06에 발행·이미지 업로드까지로 다시 썼다.
//
// 실측(2026-10-06 setup:tistory 스냅샷, .local/dom-snapshots/tistory/):
//   - 글쓰기 URL: https://{blog}.tistory.com/manage/newpost/
//   - 제목:   textarea#post-title-inp
//   - 본문:   TinyMCE 인스턴스 "editor-tistory" (iframe#editor-tistory_ifr) -> tinymce.get(id).setContent(html)
//   - 태그:   input#tagText (Enter로 확정)
//   - 카테고리: button#category-btn (combobox, aria-controls=category-list) -> 목록에서 이름으로 클릭
//   - 첨부:   div#mceu_0[aria-label=첨부] > button#mceu_0-open -> 메뉴의 "사진" -> OS 파일 선택창(filechooser)
//   - 발행 레이어: button#publish-layer-btn("완료") -> .editor_layer 안 form
//       공개 범위 radio name=basicSet: #open20 공개 / #open15 공개(보호) / #open0 비공개
//       URL: input#urlPublish (https://{blog}.tistory.com/entry/ 뒤에 붙는 슬러그)
//       대표이미지: .box_thumb input[type=file] (이 파일은 안 쓴다 - 본문 첫 이미지가 대표로 잡힌다)
//       버튼: #unpublish-btn(취소) / #publish-btn(type=submit, 공개면 "공개 발행", 비공개면 "비공개 저장")
//
// 각 단계 후 값을 되읽어 실제 반영을 확인한다 - "조용히 잘못된 성공"을 내지 않는다(옛 클래스의 교훈).
// 로그인이 풀려 있으면 `stage: "login"`으로 돌려주고, 호출자(폴러)가 이를 "실패"가 아니라 "대기"로 다룬다.
//
// page.evaluate에 넘기는 코드는 **문자열**로 둔다. tsx(esbuild)가 함수에 `__name(...)`을 끼워 넣어 브라우저에서
// "ReferenceError: __name is not defined"로 죽는다(setupTistorySession.ts 2026-10-06 실측).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";

import { TISTORY_CONFIG, tistoryBlogName } from "../../../config/publishTargets.js";
import { ANY_IMAGE_MARKER } from "../naverImageMarkers.js";
import { restoreSessionCookies, saveSessionCookies } from "./tistorySessionCookies.js";

export type TistoryPublishStage =
  | "login"
  | "navigate"
  | "editor-init"
  | "title"
  | "category"
  | "body"
  | "images"
  | "tags"
  | "publish-layer"
  | "publish";

export type TistoryVisibility = "public" | "private";

export type TistoryPublishImageInput = { url: string; alt?: string; marker?: string };

export type TistoryPublishInput = {
  title: string;
  /** 이미지 자리에 표식(⟦IMG-n⟧)만 있는 HTML. 표식 자리에서 images를 순서대로 업로드한다. */
  bodyHtml: string;
  images: ReadonlyArray<TistoryPublishImageInput>;
  tags?: string[];
  /** 티스토리 카테고리 **이름**. 목록에 없으면 기본값 그대로 두고 경고만 남긴다. */
  categoryName?: string;
};

export type TistoryPublishResult =
  | { ok: true; url: string; warnings: string[] }
  | { ok: false; stage: TistoryPublishStage; error: string };

export type TistoryLoginCheckResult = { loggedIn: true } | { loggedIn: false; reason: string };

const SELECTORS = {
  title: "#post-title-inp",
  editorInstanceId: "editor-tistory",
  editorIframeName: "editor-tistory_ifr",
  tagInput: "#tagText",
  categoryButton: "#category-btn",
  categoryList: "#category-list",
  attachOpen: "#mceu_0-open",
  publishLayerButton: "#publish-layer-btn",
  publishLayer: ".editor_layer",
  visibilityPublic: "#open20",
  visibilityPrivate: "#open0",
  urlSlug: "#urlPublish",
  publishButton: "#publish-btn",
} as const;

const EDITOR_INIT_TIMEOUT_MS = 25_000;
const CLICK_TIMEOUT_MS = 10_000;
const FILE_CHOOSER_TIMEOUT_MS = 10_000;
const IMAGE_UPLOAD_WAIT_MS = 40_000;
const UPLOAD_SETTLE_MS = 1_200;
const PUBLISH_WAIT_MS = 30_000;
const FAILURE_SNAPSHOT_DIR = ".local/dom-snapshots/tistory/failures";

export function isTistoryLoginUrl(url: string): boolean {
  return (
    url.includes("accounts.kakao.com") ||
    url.includes("logins.daum.net") ||
    url.includes("/auth/login") ||
    url.includes("kauth.kakao.com")
  );
}

/** TinyMCE 본문의 상태(텍스트·이미지 수). 업로드 확인과 표식 청소에 쓴다. */
const BODY_STATE_JS = `(() => {
  const ed = window.tinymce && window.tinymce.get("${SELECTORS.editorInstanceId}");
  if (!ed) return { ready: false, text: "", images: 0, length: 0 };
  const body = ed.getBody();
  return {
    ready: !!ed.initialized,
    text: body ? body.innerText || "" : "",
    images: body ? body.querySelectorAll("img").length : 0,
    length: (ed.getContent() || "").length,
  };
})()`;

/** 표식 문단을 찾아 **그 문단의 글자를 비우고** 커서를 그 안에 둔다. 못 찾으면 false. */
const FOCUS_MARKER_JS = (marker: string): string => `(() => {
  const ed = window.tinymce && window.tinymce.get("${SELECTORS.editorInstanceId}");
  if (!ed) return false;
  const body = ed.getBody();
  const marker = ${JSON.stringify(marker)};
  const blocks = Array.from(body.querySelectorAll("p, div, h1, h2, h3, h4, li"));
  const target = blocks.find((el) => (el.innerText || "").trim() === marker);
  if (!target) return false;
  target.innerHTML = "<br data-mce-bogus=\\"1\\">";
  ed.selection.setCursorLocation(target, 0);
  ed.focus();
  return true;
})()`;

/** 본문 끝에 커서를 둔다(표식을 못 찾은 이미지는 끝에 붙인다). */
const FOCUS_END_JS = `(() => {
  const ed = window.tinymce && window.tinymce.get("${SELECTORS.editorInstanceId}");
  if (!ed) return false;
  ed.selection.select(ed.getBody(), true);
  ed.selection.collapse(false);
  ed.focus();
  return true;
})()`;

/** 남은 표식 문단(업로드 실패 자리)을 지운다. 지운 표식 목록을 돌려준다. */
const REMOVE_LEFTOVER_MARKERS_JS = `(() => {
  const ed = window.tinymce && window.tinymce.get("${SELECTORS.editorInstanceId}");
  if (!ed) return [];
  const re = /${ANY_IMAGE_MARKER.source}/;
  const removed = [];
  Array.from(ed.getBody().querySelectorAll("p, div")).forEach((el) => {
    const text = (el.innerText || "").trim();
    if (re.test(text)) { removed.push(text); el.remove(); }
  });
  return removed;
})()`;

export type TistoryPublisherOptions = {
  blogUrl?: string;
  profileDir?: string;
  /** 기본 headless. 본문은 TinyMCE API로 넣어 클립보드·포커스가 필요 없다(네이버와 달리 창을 띄우지 않아도 된다). */
  headless?: boolean;
};

export class TistoryPublisher {
  private readonly blogName: string;
  private readonly profileDir: string;
  private readonly headless: boolean;

  constructor(options: TistoryPublisherOptions = {}) {
    const blogUrl = options.blogUrl ?? TISTORY_CONFIG.blogUrl;
    this.blogName = tistoryBlogName(blogUrl);
    if (!this.blogName) throw new Error(`TISTORY_BLOG_URL이 올바르지 않습니다: ${blogUrl}`);
    this.profileDir = options.profileDir ?? TISTORY_CONFIG.profileDir;
    this.headless = options.headless ?? process.env.TISTORY_HEADLESS !== "false";
  }

  private get writeUrl(): string {
    return `https://${this.blogName}.tistory.com/manage/newpost/`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** 프로필을 띄우고 따로 보관한 로그인 쿠키를 넣는다(tistorySessionCookies.ts - 세션 쿠키는 프로필만으로 안 남는다). */
  private async launch(): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(this.profileDir, { headless: this.headless, viewport: { width: 1280, height: 900 } });
    await restoreSessionCookies(context, this.profileDir).catch(() => 0);
    return context;
  }

  /** 로그인된 채로 화면을 열었으면 쿠키를 최신으로 갈아 둔다(실패해도 발행에는 영향 없음). */
  private async refreshSavedCookies(context: BrowserContext): Promise<void> {
    await saveSessionCookies(context, this.profileDir).catch(() => 0);
  }

  /**
   * 로그인 상태만 확인한다(발행 요청이 없을 때 하루 1회 사전 점검용). 글쓰기 화면을 열어 보고 닫는다 -
   * 관리 페이지를 한 번 여는 것 자체가 세션 쿠키를 갱신하는 효과도 기대한다(보장은 없다).
   */
  async checkLogin(): Promise<TistoryLoginCheckResult> {
    const context = await this.launch();
    try {
      const page = await context.newPage();
      await page.goto(this.writeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);
      if (isTistoryLoginUrl(page.url())) return { loggedIn: false, reason: "로그인 화면으로 이동됨" };
      await this.refreshSavedCookies(context);
      return { loggedIn: true };
    } catch (error) {
      return { loggedIn: false, reason: this.errorMessage(error) };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async publish(input: TistoryPublishInput, visibility: TistoryVisibility): Promise<TistoryPublishResult> {
    const warnings: string[] = [];
    const context = await this.launch();
    try {
      const page = await context.newPage();
      // "저장된 글을 불러올까요?" 같은 confirm은 전부 거절한다 - 새 글로 시작해야 한다.
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));

      try {
        await page.goto(this.writeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        return { ok: false, stage: "navigate", error: this.errorMessage(error) };
      }
      await page.waitForTimeout(1500);
      if (isTistoryLoginUrl(page.url())) {
        return { ok: false, stage: "login", error: "티스토리(카카오) 로그인이 풀렸습니다. 맥미니에서 npm run setup:tistory 로 다시 로그인하세요." };
      }

      await this.refreshSavedCookies(context);
      await this.dismissRestorePopup(page);

      const editorReady = await this.waitForEditor(page);
      if (!editorReady.ok) return { ok: false, stage: "editor-init", error: editorReady.error };

      // 제목
      try {
        await page.waitForSelector(SELECTORS.title, { timeout: CLICK_TIMEOUT_MS });
        await page.fill(SELECTORS.title, input.title);
        const titleValue = await page.inputValue(SELECTORS.title);
        if (titleValue.trim() !== input.title.trim()) {
          return { ok: false, stage: "title", error: `제목 반영 확인 실패(읽은 값: "${titleValue.slice(0, 40)}")` };
        }
      } catch (error) {
        return { ok: false, stage: "title", error: this.errorMessage(error) };
      }

      // 카테고리(실패해도 발행은 막지 않는다 - 글이 안 올라가는 쪽이 더 손해)
      if (input.categoryName) {
        const categoryWarning = await this.selectCategory(page, input.categoryName);
        if (categoryWarning) warnings.push(categoryWarning);
      }

      // 본문
      try {
        const length = await this.setBody(page, input.bodyHtml);
        if (length < 100) return { ok: false, stage: "body", error: `본문 반영 확인 실패(setContent 후 길이 ${length})` };
      } catch (error) {
        return { ok: false, stage: "body", error: this.errorMessage(error) };
      }

      // 이미지 - 표식 자리에서 업로드. 한 장이 실패해도 발행은 계속한다(경고로 알린다).
      try {
        warnings.push(...(await this.insertImages(page, input.images)));
        warnings.push(...(await this.removeLeftoverMarkers(page)));
      } catch (error) {
        return { ok: false, stage: "images", error: this.errorMessage(error) };
      }

      // 태그
      if (input.tags && input.tags.length > 0) {
        try {
          await this.fillTags(page, input.tags);
        } catch (error) {
          warnings.push(`태그 입력 실패: ${this.errorMessage(error).split("\n")[0]}`);
        }
      }

      // 발행 레이어
      let slug = "";
      try {
        await page.click(SELECTORS.publishLayerButton, { timeout: CLICK_TIMEOUT_MS });
        await page.waitForSelector(SELECTORS.publishLayer, { state: "visible", timeout: CLICK_TIMEOUT_MS });
        const radio = visibility === "public" ? SELECTORS.visibilityPublic : SELECTORS.visibilityPrivate;
        await page.check(radio, { timeout: CLICK_TIMEOUT_MS });
        if (!(await page.isChecked(radio))) {
          return { ok: false, stage: "publish-layer", error: `공개 범위(${visibility}) 선택이 반영되지 않았습니다.` };
        }
        slug = (await page.inputValue(SELECTORS.urlSlug).catch(() => "")).trim();
        const buttonText = (await page.textContent(SELECTORS.publishButton).catch(() => "")) ?? "";
        const expectWord = visibility === "public" ? "공개" : "비공개";
        if (!buttonText.includes(expectWord)) {
          warnings.push(`발행 버튼 문구가 예상과 다릅니다("${buttonText.trim()}") - 공개 범위를 확인하세요.`);
        }
      } catch (error) {
        await this.saveFailureSnapshot(page, "publish-layer");
        return { ok: false, stage: "publish-layer", error: this.errorMessage(error) };
      }

      // 발행 - 글쓰기 화면을 벗어나는 것(목록/글 페이지로 이동)을 성공 신호로 본다.
      try {
        const left = page.waitForURL((url) => !url.toString().includes("/manage/newpost"), { timeout: PUBLISH_WAIT_MS });
        await page.click(SELECTORS.publishButton, { timeout: CLICK_TIMEOUT_MS });
        await left;
      } catch (error) {
        await this.saveFailureSnapshot(page, "publish");
        return { ok: false, stage: "publish", error: `발행 확인 신호(글쓰기 화면 이탈)를 ${PUBLISH_WAIT_MS / 1000}초 내 감지하지 못했습니다: ${this.errorMessage(error).split("\n")[0]}` };
      }

      // 발행 레이어에서 읽은 슬러그는 티스토리가 발행 시 다듬어(쉼표 제거 등) 실제 주소와 달라질 수 있다
      // (2026-10-07 실측: 알림 주소가 404). 공개 글은 RSS에서 제목으로 실제 주소를 찾는다. 비공개는 RSS에 없다.
      const slugUrl = slug
        ? `https://${this.blogName}.tistory.com/entry/${encodeURI(slug)}`
        : `https://${this.blogName}.tistory.com/manage/posts/`;
      let url = slugUrl;
      if (visibility === "public") {
        const fromRss = await this.resolveUrlFromRss(input.title).catch(() => null);
        if (fromRss) url = fromRss;
        else warnings.push("RSS에서 발행 글을 찾지 못해 추정 주소를 돌려줍니다(다듬어진 슬러그면 404일 수 있습니다).");
      }
      if (!slug && url === slugUrl) warnings.push("발행 URL 슬러그를 읽지 못해 관리 화면 주소를 돌려줍니다.");
      return { ok: true, url, warnings };
    } finally {
      await context.close().catch(() => {});
    }
  }

  // ---------- 단계별 도우미 ----------

  private async dismissRestorePopup(page: Page): Promise<void> {
    // "작성 중이던 글이 있습니다. 이어서 작성할까요?" 류의 레이어. 새 글로 시작한다.
    for (const label of ["새로 작성", "취소", "아니오", "닫기"]) {
      const btn = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    }
  }

  private async bodyState(page: Page): Promise<{ ready: boolean; text: string; images: number; length: number }> {
    return (await page.evaluate(BODY_STATE_JS).catch(() => ({ ready: false, text: "", images: 0, length: 0 }))) as {
      ready: boolean;
      text: string;
      images: number;
      length: number;
    };
  }

  private async waitForEditor(page: Page): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + EDITOR_INIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.bodyState(page)).ready) return { ok: true };
      await page.waitForTimeout(500);
    }
    return { ok: false, error: `TinyMCE 에디터(${SELECTORS.editorInstanceId})가 ${EDITOR_INIT_TIMEOUT_MS / 1000}초 내 초기화되지 않았습니다.` };
  }

  /** 카테고리 목록을 열어 이름으로 고른다. 못 고르면 경고 문자열. */
  private async selectCategory(page: Page, name: string): Promise<string | null> {
    try {
      await page.click(SELECTORS.categoryButton, { timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
      const item = page.locator(`${SELECTORS.categoryList} [role=option], ${SELECTORS.categoryList} li, ${SELECTORS.categoryList} a, ${SELECTORS.categoryList} button`)
        .filter({ hasText: name })
        .first();
      if ((await item.count().catch(() => 0)) === 0) {
        await page.keyboard.press("Escape").catch(() => {});
        return `카테고리 "${name}"을 목록에서 찾지 못해 기본값으로 둡니다.`;
      }
      await item.click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
      const label = ((await page.textContent(SELECTORS.categoryButton).catch(() => "")) ?? "").replace(/\s+/g, " ");
      if (!label.includes(name)) return `카테고리 선택이 반영되지 않았습니다(버튼 문구: "${label.trim()}").`;
      return null;
    } catch (error) {
      await page.keyboard.press("Escape").catch(() => {});
      return `카테고리 선택 실패: ${this.errorMessage(error).split("\n")[0]}`;
    }
  }

  /** TinyMCE API로 본문을 넣고 되읽어 길이를 돌려준다. API가 없으면 iframe body에 직접 넣는다. */
  private async setBody(page: Page, html: string): Promise<number> {
    const js = `(() => {
      const ed = window.tinymce && window.tinymce.get("${SELECTORS.editorInstanceId}");
      if (!ed || typeof ed.setContent !== "function") return -1;
      ed.setContent(${JSON.stringify(html)});
      if (ed.undoManager && ed.undoManager.add) ed.undoManager.add();
      if (ed.setDirty) ed.setDirty(true);
      if (ed.fire) { ed.fire("change"); ed.fire("input"); }
      return (ed.getContent() || "").length;
    })()`;
    const length = (await page.evaluate(js)) as number;
    if (length >= 0) return length;

    const frame: Frame | null = page.frame({ name: SELECTORS.editorIframeName });
    if (!frame) throw new Error(`에디터 iframe(${SELECTORS.editorIframeName})을 찾지 못했습니다.`);
    return (await frame.evaluate(`(() => { document.body.innerHTML = ${JSON.stringify(html)}; return document.body.innerHTML.length; })()`)) as number;
  }

  /**
   * 표식 자리마다 "첨부 > 사진"으로 파일을 올린다. 파일은 **먼저 전부 받아 둔다** - 에디터를 건드린 뒤
   * 다운로드가 실패하면 본문이 반쯤 망가진 채 남는다(NaverBlogPublisher와 같은 원칙).
   */
  private async insertImages(page: Page, images: ReadonlyArray<TistoryPublishImageInput>): Promise<string[]> {
    const warnings: string[] = [];
    if (images.length === 0) return warnings;

    const prepared: { image: TistoryPublishImageInput; localPath: string }[] = [];
    for (const image of images) {
      try {
        prepared.push({ image, localPath: await this.downloadToTempFile(image.url) });
      } catch (error) {
        warnings.push(`이미지를 내려받지 못했습니다(${this.errorMessage(error).split("\n")[0]}).`);
      }
    }

    let inserted = (await this.bodyState(page)).images;
    for (const { image, localPath } of prepared) {
      const placed = image.marker ? ((await page.evaluate(FOCUS_MARKER_JS(image.marker))) as boolean) : false;
      if (!placed) {
        await page.evaluate(FOCUS_END_JS).catch(() => {});
        if (image.marker) warnings.push(`본문에서 이미지 자리(${image.marker})를 찾지 못해 끝에 붙였습니다.`);
      }

      try {
        await this.uploadWithRetry(page, localPath, image.marker);
        inserted += 1;
        if (!(await this.waitForImageCount(page, inserted))) {
          inserted -= 1;
          warnings.push(`이미지 업로드가 확인되지 않았습니다(${image.alt || image.url}).`);
          // 실패한 업로드가 에디터의 첨부 위젯을 꼬아 두면 다음 이미지까지 연쇄로 실패한다
          // (2026-10-08 우크라 글: 2번 실패 후 3~5번 전부 유실). 상태를 털고 다음으로 넘어간다.
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(UPLOAD_SETTLE_MS * 2);
        } else {
          const captionWarning = await this.writeCaption(page, image.alt ?? "");
          if (captionWarning) warnings.push(captionWarning);
          await page.waitForTimeout(UPLOAD_SETTLE_MS);
        }
      } catch (error) {
        warnings.push(`이미지 업로드 실패${image.marker ? `(${image.marker})` : ""}: ${this.errorMessage(error).split("\n")[0]}`);
      }
    }
    return warnings;
  }

  private async uploadWithRetry(page: Page, localPath: string, marker?: string): Promise<void> {
    try {
      await this.uploadAtCursor(page, localPath);
    } catch (firstError) {
      await this.saveFailureSnapshot(page, "image");
      console.warn(`[tistory] 파일 선택창 대기 실패${marker ? `(${marker})` : ""} - 재시도: ${this.errorMessage(firstError).split("\n")[0]}`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(UPLOAD_SETTLE_MS * 2);
      await this.uploadAtCursor(page, localPath);
    }
  }

  /** 첨부 메뉴를 열고 "사진"을 눌러 OS 파일 선택창을 띄운 뒤 파일을 넘긴다. */
  private async uploadAtCursor(page: Page, localPath: string): Promise<void> {
    await page.click(SELECTORS.attachOpen, { timeout: CLICK_TIMEOUT_MS });
    const photoItem = page.locator(".mce-menu-item, [role=menuitem]").filter({ hasText: "사진" }).first();
    await photoItem.waitFor({ state: "visible", timeout: CLICK_TIMEOUT_MS });
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: FILE_CHOOSER_TIMEOUT_MS }),
      photoItem.click({ timeout: CLICK_TIMEOUT_MS }),
    ]);
    await fileChooser.setFiles(localPath);
  }

  /**
   * 방금 올린 이미지(문서상 마지막 figure)의 캡션을 넣는다(2026-10-06 실측). 티스토리 에디터는 업로드한 이미지를
   * `<figure data-ke-type="image"><img …><figcaption></figcaption></figure>`로 두고, figcaption 글자를 본문 저장 형식
   * `[##_Image|…|{"caption":"…"}_##]`에 싣는다. 그래서 figcaption에 글자만 넣으면 된다(네이버처럼 UI를 클릭할 필요 없음).
   * 실패해도 발행은 막지 않고 경고만 돌려준다.
   */
  private async writeCaption(page: Page, caption: string): Promise<string | null> {
    const text = caption.replace(/\s+/g, " ").trim();
    if (!text) return null;
    const js = `(() => {
      const ed = window.tinymce && window.tinymce.get("${SELECTORS.editorInstanceId}");
      if (!ed) return "no-editor";
      const figs = ed.getBody().querySelectorAll("figure[data-ke-type=image]");
      if (figs.length === 0) return "no-figure";
      const fig = figs[figs.length - 1];
      let cap = fig.querySelector("figcaption");
      if (!cap) { cap = ed.getDoc().createElement("figcaption"); fig.appendChild(cap); }
      cap.textContent = ${JSON.stringify(text)};
      if (ed.setDirty) ed.setDirty(true);
      if (ed.fire) { ed.fire("change"); ed.fire("input"); }
      // 저장 형식([##_Image|...|{"caption":...}])은 특수문자를 엔티티로 바꾼다(2026-10-07 오탐 실측: "·" 포함 캡션이
      // 실제로는 들어갔는데 not-serialized로 찍혔다). 한글·영숫자만 남겨 비교한다.
      const norm = (v) => String(v).replace(/[^0-9A-Za-z\uAC00-\uD7A3]/g, "");
      return norm(ed.getContent() || "").includes(norm(${JSON.stringify(text)}).slice(0, 20)) ? "ok" : "not-serialized";
    })()`;
    const result = (await page.evaluate(js).catch((error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`)) as string;
    return result === "ok" ? null : `이미지 캡션 입력 실패(${result}): ${text.slice(0, 30)}`;
  }

  private async waitForImageCount(page: Page, want: number): Promise<boolean> {
    const deadline = Date.now() + IMAGE_UPLOAD_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await this.bodyState(page)).images >= want) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async removeLeftoverMarkers(page: Page): Promise<string[]> {
    const removed = (await page.evaluate(REMOVE_LEFTOVER_MARKERS_JS).catch(() => [])) as string[];
    return removed.map((marker) => `이미지가 들어가지 않은 자리를 비웠습니다(${marker}).`);
  }

  private async fillTags(page: Page, tags: string[]): Promise<void> {
    if (!(await page.locator(SELECTORS.tagInput).isVisible().catch(() => false))) return;
    for (const tag of tags.slice(0, 10)) {
      const clean = tag.replace(/^#/, "").trim();
      if (!clean) continue;
      await page.fill(SELECTORS.tagInput, clean);
      await page.press(SELECTORS.tagInput, "Enter");
      await page.waitForTimeout(250);
    }
  }

  /**
   * 이미지를 받아 임시 파일로 저장한다. 확장자는 URL이 아니라 **실제 바이트**로 정한다 - 웹 수집 단계가
   * AVIF를 `.png` 이름으로 저장한 사례가 있었고(2026-10-08 우크라 글), 티스토리 에디터는 AVIF를 받으면
   * 업로드 위젯이 꼬여 **그 뒤의 정상 이미지까지 연쇄로 실패**했다. AVIF는 macOS 내장 sips로 JPEG로
   * 변환해 올리고, 변환이 안 되면 던진다 - 이 한 장을 건너뛰는 것이(경고 1건) 에디터를 꼬이게 두는
   * 것(나머지 전부 유실)보다 낫다.
   */
  private async downloadToTempFile(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`이미지 다운로드 실패(HTTP ${response.status}): ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = mkdtempSync(path.join(tmpdir(), "tistory-publish-"));

    const sniffed = sniffImageFormat(buffer);
    const urlExt = url.split("?")[0].match(/\.([a-zA-Z0-9]+)$/)?.[1];
    const ext = sniffed ?? urlExt ?? "png";
    const filePath = path.join(dir, `image.${ext}`);
    writeFileSync(filePath, buffer);

    if (sniffed !== "avif") return filePath;
    const converted = path.join(dir, "image.jpg");
    try {
      execFileSync("sips", ["-s", "format", "jpeg", filePath, "--out", converted], { stdio: "pipe" });
    } catch (error) {
      throw new Error(`AVIF 이미지를 JPEG로 변환하지 못해 건너뜁니다(${this.errorMessage(error).split("\n")[0]}): ${url}`);
    }
    return converted;
  }

  /** 발행 직후 RSS에서 같은 제목의 글을 찾아 실제 주소를 돌려준다. 반영이 늦을 수 있어 짧게 재시도한다. */
  private async resolveUrlFromRss(title: string): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(`https://${this.blogName}.tistory.com/rss`);
        if (res.ok) {
          const link = matchRssLink(await res.text(), title);
          if (link) return link;
        }
      } catch {
        // 네트워크 실패는 재시도로
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return null;
  }

  private async saveFailureSnapshot(page: Page, label: string): Promise<void> {
    try {
      mkdirSync(FAILURE_SNAPSHOT_DIR, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(`${FAILURE_SNAPSHOT_DIR}/${timestamp}_${label}.html`, await page.content(), "utf-8");
      await page.screenshot({ path: `${FAILURE_SNAPSHOT_DIR}/${timestamp}_${label}.png`, fullPage: true }).catch(() => {});
    } catch {
      // 진단 저장 실패는 무시한다.
    }
  }
}

// ---------- RSS 제목 매칭(순수 함수, 테스트: testTistoryPublishedUrl.ts) ----------

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&middot;/g, "\u00b7")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** 비교용 정규화 - RSS가 특수문자를 엔티티로 바꾸므로 한글·영숫자만 남긴다(캡션 검증과 같은 이유). */
function normalizeTitle(text: string): string {
  return decodeEntities(text).replace(/[^0-9A-Za-z\uAC00-\uD7A3]/g, "");
}

/** RSS XML에서 제목이 같은 item의 link. 같은 제목이 여럿이면 최신(첫 번째) 것. */
export function matchRssLink(rssXml: string, title: string): string | null {
  const want = normalizeTitle(title);
  if (!want) return null;
  for (const match of rssXml.matchAll(/<item>.*?<title>(.*?)<\/title>.*?<link>(.*?)<\/link>/gs)) {
    if (normalizeTitle(match[1]) === want) return decodeEntities(match[2]).trim();
  }
  return null;
}

/**
 * 이미지 버퍼의 실제 형식(확장자 문자열). URL 확장자는 믿지 않는다 - 웹 수집 이미지가 AVIF를
 * `.png` 이름으로 저장한 실측(2026-10-08)이 계기. 모르는 형식이면 null.
 */
export function sniffImageFormat(buffer: Buffer): "jpg" | "png" | "gif" | "webp" | "avif" | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  // ISO BMFF: [4바이트 크기]["ftyp"][브랜드]. avif(정지)·avis(시퀀스) 둘 다 AVIF다.
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "avif";
  }
  return null;
}
