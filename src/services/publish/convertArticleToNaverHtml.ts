// articles.content(마크다운 부분집합)를 네이버 SmartEditor 본문에 붙여넣을 HTML 문자열로 변환한다.
//
// 왜 HTML 문자열인가(markdownToTelegraphNodes.ts와 다른 이유): Telegraph는 API가 Node[] 트리를
// 요구하지만, SmartEditor는 API가 없다(§3 - 이게 이 스프린트가 위험한 이유). 유일한 입력 경로는
// 브라우저 자동화이고, 리치텍스트 에디터에 서식 있는 콘텐츠를 넣는 표준적인 방법은 contenteditable
// 영역에 HTML paste 이벤트를 발생시키는 것이다(SmartEditor는 워드/구글독스 붙여넣기를 지원하므로
// 이 경로가 있다고 가정한다) - NaverBlogPublisher.ts가 이 HTML을 ClipboardEvent data로 실어
// 본문 요소에 dispatch한다.
//
// ⚠️ 이 변환 결과가 SmartEditor에 붙여넣었을 때 실제로 어떻게 반영되는지(단은 유지, 이미지는
// 자동 재업로드, 헤더는 se-title 스타일로 매핑 등)는 아직 라이브로 검증하지 못했다
// (SPRINT_4_DESIGN.md §10-4/§10-7에서 실측 예정) - 최악의 경우 서식이 무시되고 텍스트만
// 들어갈 수 있다는 뜻이고, 그래도 "본문 내용 자체는 들어간다"는 최소 요구는 만족한다.
//
// 마크다운 부분집합은 markdownToTelegraphNodes.ts와 동일하다(buildArticlePrompt.ts가 강제하는
// 형식) - **소제목**(볼드 한 줄, 바로 다음 줄에 문단) / **굵게** / *이탤릭* / [텍스트](URL) /
// - 목록 / ![alt](url) 이미지 / 문단 사이 빈 줄 1개, 이미지 마커 앞뒤 빈 줄 2개(writer.md §6·§8,
// 2026-09-06).

import { renderPublishBlocks } from "./renderPublishBlocks.js";
import type { PublishRenderOptions } from "./renderPublishBlocks.js";

/** "![alt](url)" 한 줄짜리 블록인지 확인한다. generateArticleImages.ts가 이 형식으로만 삽입한다. */
const IMAGE_LINE_PATTERN = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

/**
 * 본문에서 "![alt](url)" 이미지 블록만 제거한다(그 외 텍스트는 그대로 유지).
 *
 * 왜 필요한가: publishArticleToNaver.ts는 이미지를 본문 paste 안의 <img> 태그가 아니라
 * NaverBlogPublisher의 toolbar 업로드 경로(setInputFiles)로 따로 넣는다 - paste로 들어간
 * 외부 URL 이미지가 SmartEditor에 실제로 반영되는지 아직 검증 못했고(§6-2), toolbar 업로드는
 * Playwright에서 훨씬 신뢰도가 높은 표준 경로이기 때문이다. 두 경로를 동시에 쓰면 이미지가
 * 중복 삽입되므로, paste용 HTML을 만들기 전에 이 함수로 이미지 블록을 먼저 걷어낸다.
 */
export function stripImageMarkdownBlocks(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .filter((block) => !IMAGE_LINE_PATTERN.test(block.trim()))
    .join("\n\n");
}

/**
 * 네이버 SmartEditor용 옵션. 굵게는 <b>, 이미지는 <img> 하나.
 * **간격·글자 크기 규칙은 renderPublishBlocks.ts가 한 곳에서 정한다**(2026-10-02).
 */
const NAVER_OPTIONS: PublishRenderOptions = {
  boldTag: "b",
  italicTag: "i",
  image: "img",
  linkTarget: false,
};

/** 원고 본문(마크다운 부분집합)을 SmartEditor 붙여넣기용 HTML로 변환한다. */
export function convertArticleToNaverHtml(markdown: string): string {
  return renderPublishBlocks(markdown, NAVER_OPTIONS);
}
