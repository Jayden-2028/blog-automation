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
import { chromium, type Locator, type Page } from "playwright";

import { NAVER_DEFAULT_CATEGORY_NO } from "../../config/naverCategoryMapping.js";
import { NAVER_PUBLISH_CONFIG } from "../../config/naverPublish.js";
import { ANY_IMAGE_MARKER } from "./naverImageMarkers.js";
import {
  describePasteGap,
  expectBodyFormat,
  isBodyFilled,
  isPasteFormatted,
  LARGE_FONT_MIN_PX,
} from "./naverPasteCheck.js";
import type { BodyFormatObserved } from "./naverPasteCheck.js";

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

export type NaverPublishImageInput = {
  url: string;
  alt?: string;
  /**
   * 본문에 박힌 자리 표식(`⟦IMG-1⟧`). 있으면 **그 표식을 찾아가 그 자리에** 업로드한다
   * (naverImageMarkers.ts). 없으면 커서 위치(=본문 끝)에 차례로 붙는다 - 옛 동작.
   */
  marker?: string;
};

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
  /**
   * `warnings`: 올라가긴 했지만 사람이 알아야 하는 차이(이미지 일부 누락 등). 조용히 넘기면
   * 2026-10-03처럼 "서식·이미지가 하나도 없는 글이 성공으로 보고되는" 일이 반복된다.
   */
  | { ok: true; draftUrl: string; warnings?: string[] }
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
/** 이미지 한 장을 올린 뒤 다음 동작 전에 에디터가 가라앉기를 기다리는 시간. */
const UPLOAD_SETTLE_MS = 1_000;
// 재진입 dim 오버레이(아래 dismissRecoveryOverlay 참고)가 사라지길 기다리는 상한. §12에서
// 관찰된 건 "몇 초"였다 - page.click()의 기본 30초 액션너빌리티 타임아웃보다 훨씬 짧게 잡아서,
// 오버레이가 실제로 안 걷히는 다른 문제일 때 stage 전체가 30초씩 두 번(safeClick 1차+재시도)
// 이상 걸리지 않게 한다.
const RECOVERY_DIM_WAIT_MS = 8_000;
const CLICK_TIMEOUT_MS = 10_000;
const FAILURE_SNAPSHOT_DIR = ".local/dom-snapshots/naver-publish";
/** 남은 이미지 표식을 지우는 시도 횟수 상한. 안 지워지는 표식에 걸려 무한 루프를 돌지 않게. */
const MAX_LEFTOVER_MARKER_SWEEPS = 12;

// 셀렉터 상수 (SPRINT_4_DESIGN.md §6-2 실측 기반, 2026-08-28). data-click-area는 네이버 자체
// 클릭 추적 속성으로, CSS 모듈 해시 클래스(예: save_btn__bzc5B)보다 배포에 안정적이라 우선한다.
// tpb.publish/#tag-input(발행 설정 패널)은 더 이상 쓰지 않는다(파일 상단 설명 참고).
const SELECTORS = {
  saveButton: '[data-click-area="tpb.save"]',
  titleParagraph: ".se-component.se-documentTitle .se-text-paragraph",
  bodyParagraph: '.se-component.se-text[data-a11y-title="본문"] .se-text-paragraph',
  imageToolbarButton: ".se-toolbar-item-image",
  // 이미지 컴포넌트와 그 캡션 칸("사진 설명을 입력하세요."). SmartEditor ONE 구조 기준이며
  // 실측 전이다 - 어긋나면 writeCaption이 경고로 알리고 발행은 계속된다.
  imageComponent: ".se-component.se-image",
  imageCaptionCandidates: [
    ".se-caption .se-text-paragraph",
    ".se-caption",
    '[class*="caption"] .se-text-paragraph',
    '[class*="caption"]',
  ],
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
  /**
   * 임시저장까지만. 발행 버튼을 누르지 않는다.
   *
   * 여기서는 평문 폴백을 허용한다 - 사람이 에디터에서 손보는 흐름이라 "서식 없는 초안"이
   * "빈 초안"보다 낫다. 공개로 나가는 publish()는 반대다(아래).
   */
  async saveDraft(input: NaverDraftSaveInput): Promise<NaverDraftSaveResult> {
    return this.fill(input, (page) => this.clickSave(page), true);
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
    // 평문 폴백을 쓰지 않는다(2026-10-03). 이 경로는 글을 실제로 올리므로, 서식·이미지가 빠진
    // 글이 조용히 올라가는 것보다 실패로 끝내고 재시도 버튼을 살리는 쪽이 낫다.
    return this.fill(input, (page) => this.clickPublish(page, visibility), false);
  }

  /** 제목·본문·이미지를 채우는 공통 흐름. 마지막 "완료" 동작만 호출자가 정한다. */
  private async fill(
    input: NaverDraftSaveInput,
    finish: (page: Page) => Promise<string>,
    allowPlainTextFallback: boolean
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

      let warnings: string[] = [];
      try {
        warnings = await this.fillBody(page, SELECTORS.bodyParagraph, input.bodyHtml, allowPlainTextFallback);
      } catch (error) {
        await this.saveFailureSnapshot(page, "body");
        return { ok: false, stage: "body", error: this.errorMessage(error) };
      }

      if (input.images && input.images.length > 0) {
        try {
          warnings = warnings.concat(await this.insertImages(page, input.images));
        } catch (error) {
          await this.saveFailureSnapshot(page, "image");
          return { ok: false, stage: "image", error: this.errorMessage(error) };
        }
      }

      // 업로드가 실패했거나 표식을 못 찾은 자리가 남으면 독자에게 `⟦IMG-2⟧` 글자가 그대로 보인다.
      // 이미지가 빠지는 것보다 글자가 노출되는 쪽이 더 나쁘므로 무조건 지운다.
      warnings = warnings.concat(await this.removeLeftoverMarkers(page));

      try {
        const draftUrl = await finish(page);
        return { ok: true, draftUrl, warnings };
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
   * 본문을 채운다. OS 클립보드 + 붙여넣기로 **서식을 살려** 넣고, 넣은 뒤 에디터를 되읽어
   * 글자뿐 아니라 **굵게·소제목 크기까지** 들어갔는지 검증한다(naverPasteCheck.ts).
   *
   * 2026-10-03에 고친 사고: 예전에는 글자 수만 봤고, 그 측정마저 locator strict mode 때문에
   * 거짓 음성이었다(readBodyState 주석 참고). 붙여넣기가 성공했는데도 "비었다"로 읽혀
   * Cmd+A -> Backspace로 지우고 평문을 타이핑했다 - 발행된 글에 서식과 이미지가 하나도 없었다.
   *
   * 돌려주는 값은 사람에게 보여줄 경고 목록이다(발행을 막을 정도는 아니지만 알아야 하는 차이).
   */
  private async fillBody(
    page: Page,
    selector: string,
    html: string,
    allowPlainTextFallback: boolean
  ): Promise<string[]> {
    const plainText = htmlToPlainWithBreaks(html);
    const expected = expectBodyFormat(html);

    await this.pasteHtml(page, html, plainText);
    await this.safeClick(page, selector);
    await this.pressPaste(page);
    await page.waitForTimeout(1200);

    let observed = await this.readBodyState(page);

    // 글자가 아예 안 들어갔을 때만 단축키 경로로 한 번 더 시도한다. 글자가 들어간 상태에서
    // 다시 붙여넣으면 본문이 두 번 들어간다.
    if (!isBodyFilled(expected, observed)) {
      await this.safeClick(page, selector);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await page.waitForTimeout(1200);
      observed = await this.readBodyState(page);
    }

    if (isPasteFormatted(expected, observed)) {
      const warnings = describePasteGap(expected, observed);
      for (const warning of warnings) console.warn(`⚠️ [naver] ${warning}`);
      return warnings;
    }

    const gap = describePasteGap(expected, observed).join(" ") || "서식이 반영되지 않았습니다.";

    if (!allowPlainTextFallback) {
      // 공개로 나가는 경로다. 서식 없는 글을 올리느니 실패로 끝내고 재시도 버튼을 살린다.
      throw new Error(`본문 붙여넣기 실패 - ${gap}`);
    }

    console.warn(`⚠️ [naver] 붙여넣기 실패로 평문 타이핑으로 폴백합니다 - ${gap}`);
    await this.safeClick(page, selector);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(plainText, { delay: 1 });
    await page.waitForTimeout(600);

    const afterType = await this.readBodyState(page);
    if (!isBodyFilled(expected, afterType)) {
      throw new Error("본문 입력 실패 - 붙여넣기와 평문 타이핑 모두 본문이 비어 있습니다.");
    }
    return [`서식 없이 평문으로 입력했습니다(붙여넣기 실패 - ${gap}).`];
  }

  /**
   * 붙여넣기 키를 보낸다.
   *
   * macOS에서 `keyboard.press("Meta+V")`는 **브라우저 단축키**로 처리돼 렌더러에 편집 명령이
   * 전달되지 않는 경우가 있다(네이버 폴러는 맥에서만 돈다). CDP `Input.dispatchKeyEvent`에
   * `commands:["paste"]`를 실으면 렌더러가 붙여넣기 명령을 그대로 실행한다 - 사람이 Cmd+V를
   * 누른 것과 같은 경로다. CDP가 막히면 기존 단축키로 떨어진다.
   */
  private async pressPaste(page: Page): Promise<void> {
    const isMac = process.platform === "darwin";
    const modifiers = isMac ? 4 : 2; // 4 = Meta(Command), 2 = Control
    const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers };
    try {
      const client = await page.context().newCDPSession(page);
      try {
        await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, commands: ["paste"] });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
        return;
      } finally {
        await client.detach().catch(() => {});
      }
    } catch {
      await page.keyboard.press(isMac ? "Meta+V" : "Control+V");
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

  /**
   * SmartEditor 본문 상태(글자 수·이미지·굵게·큰 글씨)를 읽는다. 붙여넣기 결과 검증용.
   *
   * ⚠️ **여기에 2026-10-03 사고의 근본 원인이 있었다.** 예전 구현은
   * `page.locator('.se-component.se-text[data-a11y-title="본문"]').innerText()` 하나였는데,
   * 붙여넣기가 성공하면 본문이 **여러 컴포넌트로 쪼개져** 이 locator가 N개에 매칭된다.
   * Playwright strict mode는 그때 예외를 던지고, 뒤에 붙은 `.catch(() => "")`가 그 예외를 삼켜
   * **빈 문자열**을 돌려줬다 - 성공한 붙여넣기가 "본문이 비었다"로 읽힌 것이다.
   * 그래서 지금은 캔버스 전체를 순회해 **합산**한다(제목 컴포넌트는 뺀다).
   *
   * 큰 글씨 판정에 계산된 스타일(getComputedStyle)을 쓰는 이유: SmartEditor는 붙여넣은
   * `font-size:19px`를 자기 크기 등급(se-fs-fsNN 클래스)으로 바꿔 넣기 때문에, 인라인 style만
   * 보면 서식이 살아 있어도 못 찾는다. 실제로 렌더된 크기를 본다.
   */
  private async readBodyState(page: Page): Promise<BodyFormatObserved & { text: string }> {
    return page
      .evaluate((minPx: number) => {
        // tsconfig에 "dom" lib이 없어(Node 전용 프로젝트) document를 직접 참조할 수 없다 -
        // pasteHtml과 같은 globalThis 캐스팅 우회를 쓴다.
        const g: any = globalThis as any;
        const canvas = g.document.querySelector(".se-canvas") ?? g.document.body;
        const components: any[] = Array.from(canvas.querySelectorAll(".se-component")).filter(
          (el: any) => !el.classList.contains("se-documentTitle")
        );

        let text = "";
        let bold = 0;
        let large = 0;
        let inlineImages = 0;

        for (const el of components) {
          text += `${el.innerText ?? ""}\n`;
          bold += el.querySelectorAll("b, strong").length;
          inlineImages += el.querySelectorAll("img").length;
          const nodes: any[] = Array.from(el.querySelectorAll("span, b, strong, p"));
          const hasLarge = nodes.some((node: any) => {
            const px = Number.parseFloat(g.getComputedStyle(node).fontSize);
            return Number.isFinite(px) && px >= minPx;
          });
          if (hasLarge) large += 1;
        }

        const imageComponents = canvas.querySelectorAll(".se-component.se-image").length;
        return {
          chars: text.replace(/\s/g, "").length,
          images: Math.max(imageComponents, inlineImages),
          bold,
          large,
          text,
        };
      }, LARGE_FONT_MIN_PX)
      .catch(() => ({ chars: 0, images: 0, bold: 0, large: 0, text: "" }));
  }

  /**
   * 이미지를 **에디터에 직접 업로드**한다(2026-10-04). 외부 URL `<img>`를 붙여넣던 옛 방식은
   * 네이버 서버에 파일이 올라가지 않아 대표이미지가 안 잡히고 핫링크가 된다
   * (naverImageMarkers.ts 상단 설명).
   *
   * 순서가 중요하다: **파일을 먼저 전부 받아 둔다.** 에디터를 건드리기 시작한 뒤에 다운로드가
   * 실패하면 본문이 반쯤 망가진 채로 남는다.
   *
   * 돌려주는 값은 경고 목록이다 - 이미지 한 장이 실패해도 발행을 막지 않는다(본문·서식은 이미
   * 정상이므로, 글을 통째로 못 올리는 쪽이 손해다).
   */
  private async insertImages(page: Page, images: ReadonlyArray<NaverPublishImageInput>): Promise<string[]> {
    const warnings: string[] = [];

    const prepared: { image: NaverPublishImageInput; localPath: string }[] = [];
    for (const image of images) {
      try {
        prepared.push({ image, localPath: await this.downloadToTempFile(image.url) });
      } catch (error) {
        warnings.push(`이미지를 내려받지 못했습니다(${this.errorMessage(error)}).`);
      }
    }

    let inserted = (await this.readBodyState(page)).images;
    for (const { image, localPath } of prepared) {
      // 표식이 있으면 그 자리로 커서를 옮긴다. 못 찾으면 커서가 있는 곳(보통 본문 끝)에 들어간다.
      if (image.marker) {
        const placed = await this.focusMarker(page, image.marker);
        if (!placed) {
          warnings.push(`본문에서 이미지 자리(${image.marker})를 찾지 못해 끝에 붙였습니다.`);
        }
      }

      try {
        await this.uploadWithRetry(page, localPath, image.marker);
        inserted += 1;
        if (!(await this.waitForImageCount(page, inserted))) {
          inserted -= 1; // 실제로 안 들어갔다 - 다음 장의 기대치가 어긋나지 않게 되돌린다.
          warnings.push(`이미지 업로드가 확인되지 않았습니다(${image.alt || image.url}).`);
        } else {
          const captionWarning = await this.writeCaption(page, inserted - 1, image.alt ?? "");
          if (captionWarning) warnings.push(captionWarning);
          // 업로드 직후엔 방금 올린 이미지가 선택 상태라 곧바로 다음 툴바 클릭을 하면 파일 선택창이
          // 안 뜨는 경우가 있었다(2026-10-05 실측: 글마다 한 장씩 filechooser 타임아웃).
          await page.waitForTimeout(UPLOAD_SETTLE_MS);
        }
      } catch (error) {
        warnings.push(`이미지 업로드 실패${image.marker ? `(${image.marker})` : ""}: ${this.errorMessage(error).split("\n")[0]}`);
      }
    }

    return warnings;
  }

  /**
   * 파일 선택창이 안 뜨면 한 번 더 시도한다. 첫 시도 실패 시점의 화면을 스냅샷으로 남겨,
   * 재발하면 어떤 레이어가 툴바 클릭을 막았는지 볼 수 있게 한다.
   */
  private async uploadWithRetry(page: Page, localPath: string, marker?: string): Promise<void> {
    try {
      await this.uploadAtCursor(page, localPath);
    } catch (firstError) {
      await this.saveFailureSnapshot(page, "image").catch(() => undefined);
      console.warn(`[naver] 파일 선택창 대기 실패${marker ? `(${marker})` : ""} - 재시도: ${this.errorMessage(firstError).split("\n")[0]}`);
      await page.waitForTimeout(UPLOAD_SETTLE_MS * 2);
      await this.uploadAtCursor(page, localPath);
    }
  }

  /**
   * 방금 올린 이미지(문서 순서상 `index`번째 이미지 컴포넌트)의 캡션 칸에 글을 넣는다.
   * 표식 순서대로 올리므로 문서 순서 = 업로드 순서다. 실패해도 발행은 막지 않고 경고만 돌려준다.
   */
  private async writeCaption(page: Page, index: number, caption: string): Promise<string | null> {
    const text = caption.replace(/\s+/g, " ").trim();
    if (!text) return null;
    const component = page.locator(SELECTORS.imageComponent).nth(index);
    try {
      await component.scrollIntoViewIfNeeded({ timeout: CLICK_TIMEOUT_MS });
      // 캡션 칸은 이미지를 선택해야 나타나는 구조일 수 있다 - 먼저 이미지를 눌러 선택한다.
      await component.locator("img").first().click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(500);

      let target = null;
      for (const selector of SELECTORS.imageCaptionCandidates) {
        const candidate = component.locator(selector).first();
        if ((await candidate.count().catch(() => 0)) > 0) {
          target = candidate;
          break;
        }
      }
      if (!target) throw new Error("캡션 칸을 찾지 못했습니다");

      await target.click({ timeout: CLICK_TIMEOUT_MS, force: true });
      await page.keyboard.insertText(text);
      await page.waitForTimeout(300);
      const written = await component.innerText();
      if (!written.includes(text.slice(0, 10))) throw new Error("입력한 캡션이 화면에 보이지 않습니다");
      return null;
    } catch (error) {
      await this.saveComponentHtml(component, index);
      return `이미지 캡션 입력 실패: ${this.errorMessage(error).split("\n")[0]}`;
    }
  }

  /** 캡션 셀렉터를 실측으로 맞추기 위해, 실패한 이미지 컴포넌트의 HTML을 남긴다. */
  private async saveComponentHtml(component: Locator, index: number): Promise<void> {
    try {
      mkdirSync(FAILURE_SNAPSHOT_DIR, { recursive: true });
      const html = await component.evaluate((el) => el.outerHTML);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(`${FAILURE_SNAPSHOT_DIR}/${timestamp}_caption-component-${index}.html`, html, "utf-8");
    } catch {
      // 진단 저장 실패는 무시한다.
    }
  }

  /**
   * 본문에서 표식 문단을 찾아 **그 줄을 통째로 선택해 지우고** 커서를 그 자리에 둔다.
   * 업로드가 실패하더라도 표식 글자는 이미 사라진 상태가 되므로 독자에게 노출되지 않는다.
   */
  private async focusMarker(page: Page, marker: string): Promise<boolean> {
    const target = page.getByText(marker, { exact: false }).first();
    if ((await target.count().catch(() => 0)) === 0) return false;

    try {
      await target.scrollIntoViewIfNeeded({ timeout: CLICK_TIMEOUT_MS });
      await this.dismissRecoveryOverlay(page);
      await target.click({ clickCount: 3, timeout: CLICK_TIMEOUT_MS }); // 문단 전체 선택
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(300);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 커서 자리에 파일을 올린다. `.se-toolbar-item-image` 클릭 → 파일 선택 대화상자 → setInputFiles.
   * filechooser 대기와 클릭을 동시에 걸어야 하므로 safeClick을 그대로 못 쓴다 - 오버레이만 먼저
   * 통과시켜 둔다(§12).
   */
  private async uploadAtCursor(page: Page, localPath: string): Promise<void> {
    await this.dismissRecoveryOverlay(page);
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: FILE_CHOOSER_TIMEOUT_MS }),
      page.click(SELECTORS.imageToolbarButton),
    ]);
    await fileChooser.setFiles(localPath);
  }

  /**
   * 업로드가 끝나 이미지 컴포넌트가 실제로 생겼는지 기다린다. 고정 시간 대기를 쓰지 않는 이유는
   * 티스토리 저장에서 배운 것과 같다 - 고정 대기는 느릴 때 거짓 실패, 빠를 때 낭비가 된다.
   */
  private async waitForImageCount(page: Page, want: number): Promise<boolean> {
    const deadline = Date.now() + IMAGE_UPLOAD_WAIT_MS * 4;
    while (Date.now() < deadline) {
      if ((await this.readBodyState(page)).images >= want) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * 본문에 남은 표식 문단을 지운다. 업로드가 실패했거나 표식을 못 찾은 자리의 안전망이다.
   * 표식이 없으면 아무 일도 하지 않는다(정상 경로에서는 여기서 걸리는 게 없다).
   */
  private async removeLeftoverMarkers(page: Page): Promise<string[]> {
    const warnings: string[] = [];
    // 표식 수만큼만 돌고 멈춘다 - 지워지지 않는 표식이 있을 때 무한 루프를 돌지 않게.
    for (let attempt = 0; attempt < MAX_LEFTOVER_MARKER_SWEEPS; attempt += 1) {
      const text = (await this.readBodyState(page)).text;
      const found = text.match(ANY_IMAGE_MARKER);
      if (!found || found.length === 0) return warnings;

      const removed = await this.focusMarker(page, found[0]);
      if (!removed) {
        warnings.push(`본문에 이미지 자리 표식이 남았습니다(${found[0]}) - 발행본을 확인하세요.`);
        return warnings;
      }
      warnings.push(`이미지가 들어가지 않은 자리를 비웠습니다(${found[0]}).`);
    }
    return warnings;
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
