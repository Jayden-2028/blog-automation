// 캡처 자동화 단계들의 경계 타입. 브라우저(Playwright)와 판단(헤드리스 Claude)을 갈라 두는
// 이유는 INSTAGRAM_CAPTURE_AUTOMATION.md 참고 - 깨지기 쉬운 것과 규칙으로 못 쓰는 것을 분리한다.

/** 캐러셀에서 실제로 받아낸 것. 파일은 임시 디렉터리에 있고 호출자가 지운다. */
export type CarouselCapture = {
  /** 슬라이드 순서(1부터)와 스크린샷 경로. */
  slides: Array<{ slideIndex: number; localPath: string }>;
  /** 게시물 캡션 원문. 못 읽으면 빈 문자열. */
  caption: string;
  /** 정리해야 할 임시 디렉터리. */
  tempDir: string;
};

/** 슬라이드 한 장에서 읽어낸 것(2026-09-23: 글자만). */
export type SlideJudgement = {
  slideIndex: number;
  /** 이미지에 박힌 글자. 없으면 빈 문자열. 캡션과 함께 자료조사의 1차 근거다. */
  burnedInText: string;
};

/** 게시물 전체에 대한 판정. */
export type CarouselJudgement = {
  /** 자료조사·원고의 주제어. */
  searchKeyword: string;
  /** KeywordCategory 중 하나거나 null. */
  category: string | null;
  slides: SlideJudgement[];
};
