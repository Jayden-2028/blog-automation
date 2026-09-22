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

/** 슬라이드 한 장에 대한 모델 판정. */
export type SlideJudgement = {
  slideIndex: number;
  /** 워터마크·계정 로고·번인 텍스트가 있나. true면 그대로 쓰지 않는다. */
  hasOverlay: boolean;
  /** 이미지에 박힌 글자. 없으면 빈 문자열. 이미지를 못 써도 리서치 근거로 쓴다. */
  burnedInText: string;
  /** 이 슬라이드가 무엇을 보여주는지 한 줄. 대체 이미지 검색어의 재료. */
  description: string;
};

/** 게시물 전체에 대한 판정. */
export type CarouselJudgement = {
  /** 자료조사·원고의 주제어. */
  searchKeyword: string;
  /** KeywordCategory 중 하나거나 null. */
  category: string | null;
  slides: SlideJudgement[];
};
