// 네이버 블로그 SmartEditor 자동화 - 제목/본문/이미지를 채우고 "임시저장"까지만 수행한다.
// SPRINT_4_DESIGN.md §4/§6/§6-2/§12 근거. §10 작업 순서의 4번.
//
// ⚠️ 이 파일은 "발행"을 실행하지 않는다. 이건 안전장치가 아니라 이 스프린트의 정의 자체다
// (CLAUDE.md: "반자동 — 임시저장까지만 자동, 발행 버튼은 사람"). §6-2 실측으로 발행 흐름이
// 버튼 2단계로 나뉜다는 걸 확인했다:
//   - [data-click-area="tpb.publish"] : 상단 툴바 - 발행 "설정 패널"을 여는 버튼(태그/카테고리
//     등이 여기 있다) - 이 파일은 더 이상 이 버튼을 클릭하지 않는다(아래 "태그는 패널을 거치지
//     않는다" 참고).
//   - [data-click-area="tpb*i.publish"] (data-testid="seOnePublishBtn") : 패널 안의 진짜
//     발행 **확정** 버튼 - 이 파일 어디에서도 이 셀렉터를 클릭하지 않는다.
//   - [data-click-area="tpb.save"] : 상단 툴바 - 임시저장. 이 파일이 실제로 클릭하는 유일한
//     "완료" 액션이다.
//
// 태그는 발행 설정 패널을 거치지 않는다(2026-08-28, §10 item 7 1차 실측 후 사용자 결정) -
// 처음에는 tpb.publish를 열어 #tag-input에 태그를 입력했는데, 실제로 잘 반영됐다(패널
// 스크린샷으로 확인). 그런데 이 방식은 자동화가 발행 확정 버튼과 같은 패널을 열어야 한다는
// 점에서 "발행 버튼 근처"에 다가가는 셈이라 사용자가 더 안전한 대안을 요청했다: 원고 본문
// 끝에 이미 해시태그 줄이 텍스트로 들어가 있으므로(runArticleJob.ts가 붙인다), 그게 본문
// paste로 함께 들어가기만 하면 된다 - 사람이 실제 "발행"을 누르는 순간 네이버가 본문의
// "#태그" 텍스트를 자동으로 태그로 인식해 적용해준다(사용자 확인). 그래서 이 파일은 태그
// 입력란을 아예 건드리지 않는다 - 발행 설정 패널도 열지 않는다.
//
// 본문 붙여넣기 버그 수정 (2026-08-28, §12 1차 실측에서 실제로 발견됨): 처음에는
// document.activeElement에 합성 ClipboardEvent를 직접 dispatch했는데, 사용자가 실제 초안을
// 열어보니 제목/이미지는 들어갔지만 본문 문단이 통째로 비어 있었다 - SmartEditor(React 기반)의
// 실제 paste 핸들러가 신뢰되지 않은(합성) 이벤트를 무시한 것으로 추정된다. 그래서 실제 OS
// 클립보드에 HTML을 써넣고 Ctrl/Cmd+V를 누르는 방식으로 바꿨다 - 이건 브라우저가 "진짜" paste
// 이벤트로 인식하므로 사람이 손으로 붙여넣는 것과 동일한 경로를 탄다. Playwright의
// context.grantPermissions(["clipboard-read", "clipboard-write"])로 권한을 미리 승인해야
// navigator.clipboard.write()가 자동화 컨텍스트에서도 막히지 않는다.
//
// 미검증 사항 (2026-08-28 1차 실측 + 본문 붙여넣기 수정 이후, §12/§13 참고 - 남은 것만 기록):
//   - 수정된 클립보드 기반 본문 붙여넣기가 실제로 문단을 채우는지: 아직 라이브 재검증 전이다.
//   - "임시저장" 성공을 알리는 정확한 신호(토스트/URL 변화 등) - 아직 고정 시간 대기로 대체.
// 이 가설들이 틀렸다면 saveDraft()가 stage별 실패로 알려준다(어느 단계에서 막혔는지는 알 수
// 있다) - 조용히 잘못된 결과를 성공으로 보고하지는 않는다.
//
// 재진입 오버레이 방어 (2026-09-03, §12에서 문서만 되고 코드에는 없던 것): 실제 job:publish
// 실행에서 제목 클릭이 30초 타임아웃으로 실패하는 사례가 나왔다 - §12에서 관찰된
// `se-popup-dim` dim 오버레이(재진입 시 "이어서 작성" 류 확인창이 짧게 떴다 사라지는 것으로
// 추정)가 title 클릭 시점에 떠 있으면 page.click()이 "다른 요소에 가려짐" 판정으로 기본 30초
// 액션너빌리티 타임아웃을 그대로 소진하고 실패한다는 가설로 dismissRecoveryOverlay()/
// safeClick()을 추가했다 - 모든 클릭 지점에서 오버레이를 먼저 걷어내고(Escape), 그래도 막히면
// 한 번 더 걷어낸 뒤 짧은 타임아웃으로 재시도한다. 오버레이의 정확한 트리거 조건은 여전히
// 미확인이다(원격 세션은 실제 로그인 프로필에 접근할 수 없어 headed 재현이 불가능) - 이 가설이
// 틀렸을 경우를 대비해 stage 실패 시 saveFailureSnapshot()이 HTML+스크린샷을
// `.local/dom-snapshots/naver-publish/`에 남기므로, 다음 실패의 실제 화면 상태를 사후에 볼 수
// 있다.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

import { NAVER_DEFAULT_CATEGORY_NO } from "../../config/naverCategoryMapping.js";
import { NAVER_PUBLISH_CONFIG } from "../../config/naverPublish.js";

/** 공백을 뺀 실제 글자 수. 본문이 실제로 채워졌는지 판정하는 데 쓴다. */
function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

/**
 * bodyHtml을 문단 구분이 살아 있는 평문으로 바꾼다(붙여넣기 실패 시 keyboard.type 폴백용).
 * 블록 태그(</p>, </h2>, </li> 등)는 줄바꿈으로, 그 외 태그는 제거한다.
 */
function htmlToPlainWithBreaks(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|div|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export class NaverPublishLoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NaverPublishLoginRequiredError";
  }
}

export type NaverPublishImageInput = { url: string; alt?: string };

export type NaverDraftSaveInput = {
  title: string;
  /**
   * convertArticleToNaverHtml()의 출력 - SmartEditor 본문에 paste로 삽입할 HTML.
   * 해시태그는 여기 별도 필드가 없다 - 본문 끝에 이미 "#태그1 #태그2 ..." 텍스트 줄로 포함돼
   * paste되는 것을 그대로 쓴다(파일 상단 설명 참고, 발행 설정 패널을 열지 않는다).
   */
  bodyHtml: string;
  /**
   * 본문에 이미 마크다운으로 삽입된 이미지와는 별개로, SmartEditor 자체 업로드 기능으로도
   * 넣고 싶은 이미지 목록(선택). 비우면 이미지 업로드 단계를 건너뛴다 - bodyHtml의 <img src>가
   * paste로 그대로 남을 수도 있고(외부 링크 이미지), SmartEditor가 자동으로 재업로드할 수도
   * 있다(§6-2에서 아직 확인 못함). 확실한 삽입이 필요하면 이 옵션으로 명시적으로 업로드한다.
   */
  images?: ReadonlyArray<NaverPublishImageInput>;
};

export type NaverDraftSaveStage = "login" | "navigate" | "title" | "body" | "image" | "save";

export type NaverDraftSaveResult =
  | { ok: true; draftUrl: string }
  | { ok: false; stage: NaverDraftSaveStage; error: string };

export type NaverBlogPublisherOptions = {
  blogId?: string;
  profileDir?: string;
  /**
   * 네이버 블로그 카테고리 번호. 호출부가 `naverCategoryNo(job.category)`로 구해 넘긴다
   * (2026-09-22 - 발행 대상이 whyissuenow로 바뀌면서 매핑표를 만들었다).
   * 안 넘기면 "지금 뜨는 이슈"(1)로 간다 - 옛 기본값 32는 다른 블로그(육아)의 번호라 폐기했다.
   */
  categoryNo?: number;
  headless?: boolean;
};


const SAVE_WAIT_MS = 3000;
const IMAGE_UPLOAD_WAIT_MS = 3000;
const FILE_CHOOSER_TIMEOUT_MS = 10_000;
// 재진입 dim 오버레이(아래 dismissRecoveryOverlay 참고)가 사라지길 기다리는 상한. §12에서
// 관찰된 건 "몇 초"였다 - page.click()의 기본 30초 액션너빌리티 타임아웃보다 훨씬 짧게 잡아서,
// 오버레이가 실제로 안 걷히는 다른 문제일 때 stage 전체가 30초씩 두 번(safeClick 1차+재시도)
// 이상 걸리지 않게 한다.
const RECOVERY_DIM_WAIT_MS = 8_000;
const CLICK_TIMEOUT_MS = 10_000;
const FAILURE_SNAPSHOT_DIR = ".local/dom-snapshots/naver-publish";

// 셀렉터 상수 (SPRINT_4_DESIGN.md §6-2 실측 기반, 2026-08-28). data-click-area는 네이버 자체
// 클릭 추적 속성으로, CSS 모듈 해시 클래스(예: save_btn__bzc5B)보다 배포에 안정적이라 우선한다.
// tpb.publish/#tag-input(발행 설정 패널)은 더 이상 쓰지 않는다(파일 상단 설명 참고).
const SELECTORS = {
  saveButton: '[data-click-area="tpb.save"]',
  titleParagraph: ".se-component.se-documentTitle .se-text-paragraph",
  bodyParagraph: '.se-component.se-text[data-a11y-title="본문"] .se-text-paragraph',
  imageToolbarButton: ".se-toolbar-item-image",
  // SPRINT_4_DESIGN.md §12 - 임시저장된 초안이 있는 상태로 글쓰기 화면에 들어가면(또는 이 파일이
  // 실행한 이전 세션이 저장 없이 중간에 끊겨 미저장 초안이 남으면) 이 클래스의 dim 오버레이가
  // 짧게 뜨며 클릭을 막는다. 정확한 트리거는 미확인이지만 셀렉터 자체는 §12 실측에서 확인됨.
  recoveryDim: ".se-popup-dim",
  // 발행(2026-09-22 실측). 이 셋은 임시저장과 달리 **글이 실제로 공개된다** - 순서가 중요하다:
  // 패널 열기 -> 공개 범위 고르기 -> 확정. 확정 전에 범위를 안 고르면 네이버 기본값(전체공개)이다.
  publishPanelButton: '[data-click-area="tpb.publish"]',
  publishConfirmButton: '[data-testid="seOnePublishBtn"]',
} as const;

/**
 * 공개 범위. data-click-area는 네이버 자체 클릭 추적 속성이라 CSS 해시 클래스보다 안정적이다.
 * **전체공개와 비공개를 바꿔 쓰면 사고**라 실측 라벨을 그대로 주석에 남긴다(2026-09-22 확인).
 */
const VISIBILITY_SELECTOR = {
  public: '[data-click-area="tpb*i.all"]', // 전체공개 (id=open_public, testid=openType_2)
  private: '[data-click-area="tpb*i.secret"]', // 비공개 (id=open_private, testid=openType_0)
} as const;

export type NaverVisibility = keyof typeof VISIBILITY_SELECTOR;

export class NaverBlogPublisher {
  private readonly blogId: string;
  private readonly profileDir: string;
  private readonly categoryNo: number;
  private readonly headless: boolean;

  constructor(options: NaverBlogPublisherOptions = {}) {
    this.blogId = options.blogId ?? NAVER_PUBLISH_CONFIG.blogId;
    if (!this.blogId) {
      throw new Error("blogId가 비어 있습니다(.env의 CREATOR_ADVISOR_BLOG_ID를 확인하세요).");
    }
    this.profileDir = options.profileDir ?? NAVER_PUBLISH_CONFIG.profileDir;
    this.categoryNo = options.categoryNo ?? NAVER_DEFAULT_CATEGORY_NO;
    this.headless = options.headless ?? true;
  }

  /** 제목/본문/이미지/태그를 채우고 임시저장한다. 실제 발행은 절대 하지 않는다(파일 상단 설명 참고). */
  /** 임시저장까지만. 발행 버튼을 누르지 않는다. */
  async saveDraft(input: NaverDraftSaveInput): Promise<NaverDraftSaveResult> {
    return this.fill(input, (page) => this.clickSave(page));
  }

  /**
   * 채우고 **실제로 발행**한다(2026-09-22 사용자 결정 - 임시저장 글은 다시 열 때 레이어 팝업이
   * 떠 흐름을 꼬이게 해서 승인 즉시 발행으로 바꿨다).
   *
   * 첫 운영은 `visibility: "private"`(비공개)로 돌려 결과를 눈으로 확인한 뒤 공개로 올린다.
   */
  async publish(
    input: NaverDraftSaveInput,
    visibility: NaverVisibility
  ): Promise<NaverDraftSaveResult> {
    return this.fill(input, (page) => this.clickPublish(page, visibility));
  }

  /** 제목·본문·이미지를 채우는 공통 흐름. 마지막 "완료" 동작만 호출자가 정한다. */
  private async fill(
    input: NaverDraftSaveInput,
    finish: (page: Page) => Promise<string>
  ): Promise<NaverDraftSaveResult> {
    const context = await chromium.launchPersistentContext(this.profileDir, { headless: this.headless });
    // 본문 붙여넣기가 실제 OS 클립보드 + Ctrl/Cmd+V를 쓰므로 미리 권한을 승인해둔다(파일 상단
    // 설명 참고) - 권한이 없으면 navigator.clipboard.write()가 조용히 막힌다.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://blog.naver.com" });

    try {
      const page = await context.newPage();
      const writeUrl = `https://blog.naver.com/${this.blogId}/postwrite?categoryNo=${this.categoryNo}`;

      try {
        await page.goto(writeUrl, { waitUntil: "networkidle" });
      } catch (error) {
        return { ok: false, stage: "navigate", error: this.errorMessage(error) };
      }

      if (page.url().includes("nid.naver.com")) {
        return {
          ok: false,
          stage: "login",
          error: `NAVER 로그인이 필요합니다(세션 만료 또는 미로그인). "npm run setup:naver-publish"로 재로그인하세요.`,
        };
      }

      await page.waitForSelector(SELECTORS.titleParagraph, { timeout: 15_000 }).catch(() => {
        // 못 찾아도 여기서 던지지 않는다 - 아래 클릭 단계에서 더 구체적인 에러가 난다.
      });
      // §12 재진입 오버레이는 화면이 뜨자마자 나타났다 사라지는 것으로 추정된다 - 첫 클릭(제목)
      // 전에 한 번 통과시켜 둔다. safeClick도 각 클릭 직전에 다시 확인하므로 여기서는 놓쳐도
      // 안전망이 하나 더 있다.
      await this.dismissRecoveryOverlay(page);

      try {
        await this.focusAndType(page, SELECTORS.titleParagraph, input.title);
      } catch (error) {
        await this.saveFailureSnapshot(page, "title");
        return { ok: false, stage: "title", error: this.errorMessage(error) };
      }

      try {
        await this.fillBody(page, SELECTORS.bodyParagraph, input.bodyHtml);
      } catch (error) {
        await this.saveFailureSnapshot(page, "body");
        return { ok: false, stage: "body", error: this.errorMessage(error) };
      }

      if (input.images && input.images.length > 0) {
        try {
          await this.uploadImages(page, input.images);
        } catch (error) {
          await this.saveFailureSnapshot(page, "image");
          return { ok: false, stage: "image", error: this.errorMessage(error) };
        }
      }

      try {
        const draftUrl = await finish(page);
        return { ok: true, draftUrl };
      } catch (error) {
        await this.saveFailureSnapshot(page, "save");
        return { ok: false, stage: "save", error: this.errorMessage(error) };
      }
    } finally {
      // persistent context는 close해도 profileDir에 로그인 세션이 그대로 남는다.
      await context.close().catch(() => {});
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * SPRINT_4_DESIGN.md §12 - 재진입 dim 오버레이(SELECTORS.recoveryDim)가 떠 있으면 그 아래
   * 요소를 향한 클릭이 "다른 요소에 가려짐" 판정을 받아 page.click()의 기본 30초 액션너빌리티
   * 타임아웃을 그대로 다 쓰고 실패한다 - 이게 문서화된 "제목 클릭 30초 타임아웃"의 실제 경로로
   * 추정된다. 오버레이는 아마 "이어서 작성하시겠습니까" 류 확인창이 짧게 떴다 사라지는 것인데,
   * 이 파일은 항상 새 제목/본문을 채우므로 남아있던 내용을 이어서 쓸 이유가 없다 - Escape로
   * 닫아 버리는 게 안전한 기본값이다(발행 확정 버튼 등 다른 요소를 클릭하지 않는다).
   * 오버레이가 없으면 즉시 반환한다(정상 경로에서는 대기가 추가되지 않는다).
   */
  private async dismissRecoveryOverlay(page: Page): Promise<void> {
    const dim = page.locator(SELECTORS.recoveryDim).first();
    if ((await dim.count().catch(() => 0)) === 0) return;
    await page.keyboard.press("Escape").catch(() => {});
    await dim.waitFor({ state: "hidden", timeout: RECOVERY_DIM_WAIT_MS }).catch(() => {});
  }

  /**
   * page.click()을 오버레이 방해로부터 방어한다. 먼저 오버레이를 통과시키고(정상 경로에서는
   * no-op), 그래도 클릭이 막히면(오버레이가 재클릭 사이에 다시 떴거나 첫 통과가 늦었을 경우)
   * 한 번 더 통과를 시도한 뒤 재시도한다. 타임아웃을 기본 30초보다 짧게 잡아서, 오버레이가
   * 아닌 다른 이유로 막혔을 때도 두 번 합쳐 30초 안에 실패가 확정되게 한다.
   */
  private async safeClick(page: Page, selector: string): Promise<void> {
    await this.dismissRecoveryOverlay(page);
    try {
      await page.click(selector, { timeout: CLICK_TIMEOUT_MS });
    } catch (error) {
      await this.dismissRecoveryOverlay(page);
      await page.click(selector, { timeout: CLICK_TIMEOUT_MS });
    }
  }

  /**
   * stage 실패 시 HTML+스크린샷을 남긴다(inspectPublishLayer.ts와 같은 패턴). 원격 세션에서는
   * 실제 로그인 프로필로 headed 재현이 불가능해 근본 원인(오버레이의 정확한 트리거)을 그 자리에서
   * 못 잡으므로, 다음 실패 때 화면에 뭐가 떠 있었는지 사후에라도 볼 수 있게 최소한의 증거를
   * 남긴다. 스냅샷 저장 자체가 실패해도 원래 stage 실패를 가리면 안 되므로 예외를 삼킨다.
   */
  private async saveFailureSnapshot(page: Page, stage: NaverDraftSaveStage): Promise<void> {
    try {
      mkdirSync(FAILURE_SNAPSHOT_DIR, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = `${FAILURE_SNAPSHOT_DIR}/${timestamp}_${stage}-failed`;
      const html = await page.content().catch(() => "");
      if (html) writeFileSync(`${base}.html`, html, "utf-8");
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    } catch {
      // 증거 저장 실패는 원래 stage 실패를 가리지 않는다 - 조용히 무시한다.
    }
  }

  /**
   * 제목/본문 클릭 후 실제 키 입력을 보낸다. 파일 상단 설명대로, "보이는 영역을 클릭하면 앱이
   * 알아서 숨겨진 입력 proxy로 포커스를 옮긴다"는 가정 하에 page.keyboard.type()으로 사람이
   * 타이핑하는 것과 동일한 이벤트 경로를 쓴다 - 어떤 요소가 실제로 포커스를 받는지 몰라도 된다.
   */
  private async focusAndType(page: Page, selector: string, text: string): Promise<void> {
    await this.safeClick(page, selector);
    await page.keyboard.type(text, { delay: 10 });
  }

  /**
   * 본문을 채운다. 1차로 OS 클립보드 + Ctrl/Cmd+V 붙여넣기를 시도하고(서식 보존), 붙여넣기 후
   * 본문 요소 텍스트를 되읽어 실제로 들어갔는지 검증한다. 비어 있으면(2026-09-01 E2E에서 제목만
   * 들어가고 본문이 통째로 빈 사례 발생) 제목 입력과 같은 방식인 page.keyboard.type()으로 평문을
   * 다시 넣는다 - 서식은 잃지만 "본문 통째로 빈 초안"보다는 낫다(사용자가 발행 전 손보는 흐름).
   */
  private async fillBody(page: Page, selector: string, html: string): Promise<void> {
    const plainText = htmlToPlainWithBreaks(html);

    await this.pasteHtml(page, html, plainText);
    await this.safeClick(page, selector);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await page.waitForTimeout(1200);

    const afterPaste = await this.readBodyText(page);
    if (nonWhitespaceLength(afterPaste) >= 50) return;

    console.warn("⚠️ [naver] 본문 붙여넣기 결과가 비어 있어 평문 타이핑으로 폴백합니다.");
    await this.safeClick(page, selector);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(plainText, { delay: 1 });
    await page.waitForTimeout(600);

    const afterType = await this.readBodyText(page);
    if (nonWhitespaceLength(afterType) < 50) {
      throw new Error("본문 입력 실패 - 붙여넣기와 평문 타이핑 모두 본문 요소가 비어 있습니다.");
    }
  }

  private async pasteHtml(page: Page, html: string, plainText: string): Promise<void> {
    // tsconfig에 "dom" lib이 없어(Node 전용 프로젝트) Blob/ClipboardItem을 직접 참조할 수 없다 -
    // globalThis를 any로 캐스팅해 우회한다(실제로는 브라우저 안에서 실행되므로 타입 체크 대상 아님).
    await page.evaluate(
      async ({ htmlContent, text }) => {
        const g: any = globalThis as any;
        const item = new g.ClipboardItem({
          "text/html": new g.Blob([htmlContent], { type: "text/html" }),
          "text/plain": new g.Blob([text], { type: "text/plain" }),
        });
        await g.navigator.clipboard.write([item]);
      },
      { htmlContent: html, text: plainText }
    );
  }

  /** SmartEditor 본문 컴포넌트의 표시 텍스트를 읽는다. 붙여넣기·타이핑 결과 검증용. */
  private async readBodyText(page: Page): Promise<string> {
    return page
      .locator('.se-component.se-text[data-a11y-title="본문"]')
      .innerText()
      .catch(() => "");
  }

  /**
   * 이미지 업로드. .se-toolbar-item-image 클릭 시 네이티브 파일 선택 대화상자가 뜬다는 가정으로
   * Playwright의 filechooser 이벤트를 기다린다(§6-2에서 라이브 클릭까지는 검증 못함).
   */
  private async uploadImages(page: Page, images: ReadonlyArray<NaverPublishImageInput>): Promise<void> {
    for (const image of images) {
      const localPath = await this.downloadToTempFile(image.url);
      // filechooser 대기와 클릭을 동시에 걸어야 하므로 safeClick을 그대로 못 쓴다 - 오버레이만
      // 먼저 통과시켜 둔다(§12).
      await this.dismissRecoveryOverlay(page);
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: FILE_CHOOSER_TIMEOUT_MS }),
        page.click(SELECTORS.imageToolbarButton),
      ]);
      await fileChooser.setFiles(localPath);
      // 업로드/리사이즈 완료 신호를 아직 몰라 보수적으로 고정 시간을 기다린다(§10 item 7에서 개선).
      await page.waitForTimeout(IMAGE_UPLOAD_WAIT_MS);
    }
  }

  private async downloadToTempFile(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`이미지 다운로드 실패(HTTP ${response.status}): ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = mkdtempSync(path.join(tmpdir(), "naver-publish-"));
    const extMatch = url.split("?")[0].match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1] : "png";
    const filePath = path.join(dir, `image.${ext}`);
    writeFileSync(filePath, buffer);
    return filePath;
  }

  /**
   * 임시저장. [data-click-area="tpb.save"]만 클릭한다 - 발행 확정 버튼
   * ([data-click-area="tpb*i.publish"])은 이 파일 어디에서도 참조하지 않는다.
   */
  private async clickSave(page: Page): Promise<string> {
    await this.safeClick(page, SELECTORS.saveButton);
    await page.waitForTimeout(SAVE_WAIT_MS);
    // 저장 성공을 알리는 정확한 신호(토스트 메시지, URL 변화 등)는 아직 실측 못함(§10 item 7) -
    // 우선 현재 URL을 draftUrl로 돌려준다.
    return page.url();
  }

  /**
   * **실제 발행.** 임시저장과 달리 글이 공개된다(2026-09-22 네이버 운영 재개).
   *
   * 이 파일은 오랫동안 "발행 버튼을 누르지 않는 것이 정의"였다. 그 전제가 사용자 결정으로
   * 바뀌었다 - 임시저장 글은 다시 열 때 레이어 팝업이 떠 흐름을 꼬이게 해서, 승인하면 바로
   * 발행하기로 했다.
   *
   * 순서: 패널 열기 -> **공개 범위 고르기** -> 확정. 범위를 먼저 고르는 것이 중요하다 -
   * 확정 후에는 되돌릴 수 없고, 안 고르면 네이버 기본값인 전체공개로 나간다.
   */
  private async clickPublish(page: Page, visibility: NaverVisibility): Promise<string> {
    await this.safeClick(page, SELECTORS.publishPanelButton);
    await page.waitForSelector(SELECTORS.publishConfirmButton, { timeout: 15_000 });

    // 공개 범위. 라디오는 label이 가리고 있을 수 있어 click()이 막히면 JS로 직접 누른다.
    const radio = page.locator(VISIBILITY_SELECTOR[visibility]).first();
    await radio.click({ timeout: CLICK_TIMEOUT_MS }).catch(async () => {
      await radio.evaluate((el) => (el as unknown as { click: () => void }).click());
    });
    await page.waitForTimeout(500);

    // 고른 값이 실제로 반영됐는지 확인한다. 여기서 틀리면 비공개로 올리려던 글이 공개된다.
    const checked = await radio
      .evaluate((el) => (el as unknown as { checked: boolean }).checked)
      .catch(() => false);
    if (!checked) {
      throw new Error(`공개 범위(${visibility})가 선택되지 않았습니다 - 발행을 중단합니다.`);
    }

    await this.safeClick(page, SELECTORS.publishConfirmButton);
    // 발행 후에는 글 화면으로 이동한다. URL이 바뀌는 것을 성공 신호로 본다.
    await page.waitForURL((url) => !url.toString().includes("postwrite"), { timeout: 30_000 }).catch(() => {
      // 못 잡아도 아래에서 현재 URL을 돌려준다 - 조용히 성공으로 속이지 않도록 호출부가 확인한다.
    });
    await page.waitForTimeout(SAVE_WAIT_MS);
    return page.url();
  }
}
