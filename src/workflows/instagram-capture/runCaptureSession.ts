// 큐 항목 1건 -> article_jobs 1건. 인스타 포스팅 변환기의 오케스트레이션.
//
// 모든 바깥 의존(브라우저·모델)을 주입받는다 - 브라우저와 인스타 로그인은 맥에서만 되고 이
// 환경에서 못 돌리므로, 순서·실패 처리·빈 자료 판정은 가짜를 넣어 전부 검증한다
// (testRunCaptureSession.ts). 실제 구현은 captureInstagramCarousel.ts / judgeCarouselSlides.ts.
//
// 2026-09-23 재설계: **게시물 이미지는 쓰지 않는다.** 슬라이드를 찍는 이유는 거기 박힌 글자를
// 읽기 위해서뿐이고, 읽고 나면 버린다. 그래서 오버레이 판정도, 대체 이미지 검색도, 저작권
// 판단도 없다. 원고 이미지는 주제가 정해진 뒤 기존 파이프라인이 검색·생성한다.

import { cleanCaption } from "./cleanCaption.js";
import type { CarouselCapture, CarouselJudgement } from "./captureTypes.js";
import type { InstagramCaptureResult, InstagramQueueEntry } from "./types.js";

export type RunCaptureSessionDeps = {
  /** 게시물을 열어 슬라이드를 찍고 캡션을 읽는다. */
  capture: (url: string) => Promise<CarouselCapture>;
  /** 슬라이드에서 글자를 읽고 주제를 파악한다. */
  judge: (capture: CarouselCapture, entry: InstagramQueueEntry) => Promise<CarouselJudgement>;
  /** 임시 디렉터리 정리. 결과에 파일 경로가 남지 않으므로 이 안에서 끝낸다. */
  cleanup: (tempDir: string) => Promise<void>;
};

export type RunCaptureSessionResult =
  | { status: "ready"; capture: InstagramCaptureResult; slidesRead: number }
  /** 캡션도 번인 텍스트도 없다 - 원고를 쓸 근거가 0이라 사용자에게 주제를 물어야 한다. */
  | { status: "no_material"; instagramUrl: string }
  | { status: "failed"; error: string };

export async function runCaptureSession(
  entry: InstagramQueueEntry,
  deps: RunCaptureSessionDeps
): Promise<RunCaptureSessionResult> {
  let captured: CarouselCapture | null = null;

  try {
    captured = await deps.capture(entry.instagramUrl);

    // 캡션은 슬라이드와 **별도 경로**(og:description)로 온다. 슬라이드를 한 장도 못 찍어도
    // 캡션은 살아 있는 경우가 많아, 그것만으로도 원고를 쓴다(2026-09-23 사용자 결정).
    const caption = cleanCaption(captured.caption) || cleanCaption(entry.rawCaption);

    let judgement: CarouselJudgement | null = null;
    if (captured.slides.length > 0) {
      judgement = await deps.judge(captured, entry);
    }

    const burnedInText = (judgement?.slides ?? [])
      .map((slide) => slide.burnedInText.trim())
      .filter((text) => text.length > 0);

    // 읽어낸 글자가 하나도 없으면 여기서 멈춘다. 주제어를 지어내면 게시물과 무관한 원고가
    // 자동으로 나간다 - 사용자에게 물어보는 편이 낫다.
    if (!caption && burnedInText.length === 0) {
      return { status: "no_material", instagramUrl: entry.instagramUrl };
    }

    // 주제어는 모델이 정한다. 슬라이드가 없어 판정을 못 돌렸으면 캡션 첫 줄로 대신한다 -
    // 조사 단계가 캡션 전문을 다시 받으므로 씨앗이 거칠어도 복구된다.
    const searchKeyword = judgement?.searchKeyword.trim() || caption.split("\n")[0].slice(0, 60).trim();
    if (!searchKeyword) {
      return { status: "failed", error: "주제어(searchKeyword)를 뽑지 못했습니다." };
    }

    return {
      status: "ready",
      slidesRead: captured.slides.length,
      capture: {
        queueEntryId: entry.id,
        instagramUrl: entry.instagramUrl,
        caption,
        burnedInText,
        searchKeyword,
        category: judgement?.category ?? null,
      },
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    // 슬라이드는 글자를 읽는 데만 썼다 - 결과가 파일을 가리키지 않으므로 여기서 지워도 안전하다
    // (2026-09-23 이전에는 결과가 경로를 들고 있어 여기서 지우면 이미지를 잃었다).
    if (captured) await deps.cleanup(captured.tempDir).catch(() => {});
  }
}
