// articles.content(마크다운 부분집합) -> 티스토리 TinyMCE에 setContent할 HTML + 업로드할 이미지 목록.
//
// 네이버 발행 변환(convertArticleToNaverPaste)과 같은 구조다: 이미지는 `<img src=외부URL>`로 넣지 않고
// 자리 표식(⟦IMG-n⟧, naverImageMarkers.ts)만 남긴 뒤, 발행기가 그 자리에서 티스토리 "첨부 > 사진"으로
// 파일을 올린다(2026-10-06 사용자 결정: 처음부터 업로드). 이유도 네이버와 같다 - 핫링크면 대표이미지가 안
// 잡히고, Supabase 이미지를 정리하는 순간 발행된 글이 깨진다.
//
// 네이버와 다른 점: 굵게는 <strong>/<em>(TinyMCE 기본 서식), 링크는 새 탭. 간격·글자 크기 규칙은
// renderPublishBlocks.ts가 한 곳에서 정한다.

import { extractImageMarkers } from "./naverImageMarkers.js";
import type { MarkedImage } from "./naverImageMarkers.js";
import { renderPublishBlocks } from "./renderPublishBlocks.js";
import type { PublishRenderOptions } from "./renderPublishBlocks.js";

const TISTORY_OPTIONS: PublishRenderOptions = {
  boldTag: "strong",
  italicTag: "em",
  image: "img",
  linkTarget: true,
};

export function convertArticleToTistoryHtml(markdown: string): { html: string; images: MarkedImage[] } {
  const { markdown: marked, images } = extractImageMarkers(markdown);
  return { html: renderPublishBlocks(marked, TISTORY_OPTIONS), images };
}
