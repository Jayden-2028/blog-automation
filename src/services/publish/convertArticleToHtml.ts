// articles.content(마크다운 부분집합) -> 독립 HTML 문자열. Blogger API(posts.insert)의 content
// 필드와 티스토리 HTML 모드 붙여넣기에 그대로 쓴다.
//
// convertArticleToNaverHtml.ts와 다른 점: 이미지를 걷어내지 않고 <img src>로 그대로 둔다.
//  - 네이버: SmartEditor toolbar 업로드 경로가 별도로 있어 paste HTML에서는 이미지를 뺐다.
//  - Blogger/티스토리: 외부 URL <img>를 본문 HTML에 그대로 넣는 것이 표준이다(Supabase Storage
//    공개 URL, SPRINT_5_DESIGN.md §2). 티스토리는 이후 실측에서 로컬 업로드로 바꿀 수 있으나
//    지금은 외부 URL로 시작한다.
//
// 마크다운 부분집합은 buildArticlePrompt.ts / generateArticleVariant.ts가 강제하는 형식과 같다:
//   **소제목**(볼드 한 줄, 바로 다음 줄에 문단) / **굵게** / *이탤릭* / [텍스트](URL) / - 목록 /
//   ![alt](url) 이미지 / 문단 사이 빈 줄 1개, 이미지 마커 앞뒤 빈 줄 2개(writer.md §6, 2026-09-06).
// 소제목은 `#` 헤더가 아니라 볼드로 렌더한다 - Blogger 테마 CSS가 h2/h3를 과하게 키우는 경우가
// 있어 <p><strong> 조합이 더 안전하다(붙여넣기 대상 테마에 안 흔들림).
// FAQ/요약도 배리에이션 프롬프트가 "**자주 묻는 질문**", "**요약**" 소제목 + 문단으로 만들므로
// 별도 처리 없이 이 규칙 그대로 변환된다.

import { renderPublishBlocks } from "./renderPublishBlocks.js";
import type { PublishRenderOptions } from "./renderPublishBlocks.js";

/**
 * Blogspot용 옵션. 굵게는 <strong>(테마 CSS에 덜 흔들린다), 이미지는 figure+figcaption(이미지 SEO),
 * 링크는 새 탭. **간격·글자 크기 규칙은 renderPublishBlocks.ts가 한 곳에서 정한다**(2026-10-02 -
 * 전에는 이 파일과 네이버 변환기가 같은 규칙을 따로 구현했다).
 */
const BLOGSPOT_OPTIONS: PublishRenderOptions = {
  boldTag: "strong",
  italicTag: "em",
  image: "figure",
  linkTarget: true,
};

/** 원고 본문(마크다운 부분집합)을 Blogspot 발행용 HTML로 변환한다. */
export function convertArticleToHtml(markdown: string): string {
  return renderPublishBlocks(markdown, BLOGSPOT_OPTIONS);
}
