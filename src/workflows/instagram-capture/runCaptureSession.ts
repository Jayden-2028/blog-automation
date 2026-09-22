// 큐 항목 1건 -> article_jobs 1건. 캡처 자동화의 오케스트레이션.
//
// 모든 바깥 의존(브라우저·모델·검색·DB)을 주입받는다 - 브라우저와 인스타 로그인은 맥에서만
// 되고 이 환경에서 못 돌리므로, 순서·실패 처리·정책 적용은 가짜를 넣어 전부 검증한다
// (testRunCaptureSession.ts). 실제 구현은 captureInstagramCarousel.ts / judgeCarouselSlides.ts.
//
// 정책은 INSTAGRAM_POSTING_CONVERTER.md "이미지 소싱 정책"을 코드로 옮긴 것이다:
//   오버레이 없음 -> 그 슬라이드를 그대로 쓴다(instagram_capture)
//   오버레이 있음 -> 같은 사진의 깨끗한 원본을 찾는다(web_alternative). 못 찾으면 그 자리는 버린다
//   번인 텍스트는 이미지를 못 써도 항상 남긴다

import type { CarouselCapture, CarouselJudgement } from "./captureTypes.js";
import type { InstagramCandidateImage, InstagramCaptureResult, InstagramQueueEntry } from "./types.js";

export type CleanAlternative = { localPath: string; sourcePage: string; note?: string | null };

export type RunCaptureSessionDeps = {
  /** 게시물을 열어 캐러셀 슬라이드를 찍는다. */
  capture: (url: string) => Promise<CarouselCapture>;
  /** 슬라이드를 보고 판정한다. */
  judge: (capture: CarouselCapture, entry: InstagramQueueEntry) => Promise<CarouselJudgement>;
  /**
   * 오버레이가 있는 슬라이드의 깨끗한 원본을 찾는다. 못 찾으면 null.
   *
   * tempDir는 **이번 캡처의 임시 디렉터리**다. 내려받은 파일을 다른 데 쓰면 cleanup이 못 지워
   * 쌓이고(매 실행마다 샌다), 두 항목을 잇달아 처리할 때 같은 파일명으로 부딪힌다.
   */
  findCleanAlternative: (input: {
    keyword: string;
    description: string;
    slideIndex: number;
    tempDir: string;
  }) => Promise<CleanAlternative | null>;
  /** 임시 디렉터리 정리. */
  cleanup: (tempDir: string) => Promise<void>;
};

export type RunCaptureSessionResult =
  | { status: "ready"; capture: InstagramCaptureResult; slidesUsed: number; slidesDropped: number }
  | { status: "failed"; error: string };

export async function runCaptureSession(
  entry: InstagramQueueEntry,
  deps: RunCaptureSessionDeps
): Promise<RunCaptureSessionResult> {
  let captured: CarouselCapture | null = null;

  try {
    captured = await deps.capture(entry.instagramUrl);

    // 슬라이드가 0장이면 job을 만들지 않는다. 이미지 없는 원고가 자동으로 나가는 것보다,
    // 실패로 남겨 사람이 보게 하는 편이 낫다(설계서 "알려진 위험").
    if (captured.slides.length === 0) {
      return { status: "failed", error: "캐러셀에서 슬라이드를 하나도 받지 못했습니다(로그인 만료 또는 DOM 변경 의심)." };
    }

    const judgement = await deps.judge(captured, entry);
    if (!judgement.searchKeyword.trim()) {
      return { status: "failed", error: "주제어(searchKeyword)를 뽑지 못했습니다." };
    }

    const byIndex = new Map(judgement.slides.map((s) => [s.slideIndex, s]));
    const images: InstagramCandidateImage[] = [];
    const burnedInText: string[] = [];
    let slidesDropped = 0;

    for (const slide of captured.slides) {
      const verdict = byIndex.get(slide.slideIndex);
      // 판정이 없는 슬라이드는 안전한 쪽으로 간다 - 오버레이가 있다고 보고 직접 쓰지 않는다.
      const hasOverlay = verdict?.hasOverlay ?? true;
      const description = verdict?.description ?? "";

      if (verdict?.burnedInText.trim()) burnedInText.push(verdict.burnedInText.trim());

      if (!hasOverlay) {
        images.push({ slideIndex: slide.slideIndex, kind: "instagram_capture", localPath: slide.localPath });
        continue;
      }

      const alternative = await deps.findCleanAlternative({
        keyword: judgement.searchKeyword,
        description,
        slideIndex: slide.slideIndex,
        tempDir: captured.tempDir,
      });
      if (alternative) {
        images.push({
          slideIndex: slide.slideIndex,
          kind: "web_alternative",
          localPath: alternative.localPath,
          sourcePage: alternative.sourcePage,
          note: alternative.note ?? null,
        });
      } else {
        // 못 찾으면 그 자리는 버린다. 번인 텍스트는 위에서 이미 남겼다.
        slidesDropped += 1;
      }
    }

    return {
      status: "ready",
      slidesUsed: images.length,
      slidesDropped,
      capture: {
        queueEntryId: entry.id,
        instagramUrl: entry.instagramUrl,
        // 사람이 텔레그램에 같이 붙여넣은 캡션이 있으면 그것을 우선한다 - 게시물에서 긁은 것보다
        // 사람이 고른 쪽이 맥락에 맞다.
        caption: entry.rawCaption.trim() || captured.caption,
        burnedInText,
        searchKeyword: judgement.searchKeyword.trim(),
        category: judgement.category,
        images,
        profileEmbedUrl: null,
      },
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (captured) await deps.cleanup(captured.tempDir).catch(() => {});
  }
}
