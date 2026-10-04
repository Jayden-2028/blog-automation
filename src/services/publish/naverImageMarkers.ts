// 네이버 본문 이미지를 **에디터에 직접 업로드**하기 위한 자리 표식 변환(2026-10-04).
//
// **왜 필요한가**(사용자 실측): 지금까지 네이버 본문의 이미지는 `<img src="https://...supabase.co/...">`
// 로 붙여넣어졌다. 네이버는 그 외부 이미지를 자기 서버로 가져가지 않으므로
//   1. 이미지 라이브러리에 남지 않고
//   2. **대표이미지가 잡히지 않는다**(네이버는 자사 서버에 올라온 이미지 중에서 고른다)
//   3. 발행된 글이 Supabase URL을 직접 가리켜, `purge:jobs --storage`로 옛 이미지를 정리하면
//      **이미 발행된 글의 이미지가 깨진다**(핫링크).
//
// **해법**: 붙여넣을 HTML에는 이미지 대신 한 줄짜리 **표식**만 넣고, 붙여넣은 뒤 그 표식을 찾아가
// 그 자리에서 에디터 툴바로 파일을 업로드한다. 위치는 표식이 지키고, 업로드는 네이버 서버로 간다.
//
// 표식 문자: `⟦IMG-1⟧`. 평범한 블로그 본문에 나올 일이 없고, 마크다운에서 아무 의미도 없어
// 인라인 변환(굵게·링크)에 걸리지 않으며, Playwright `getByText`로 찾기 쉽다.

import { IMAGE_LINE_PATTERN } from "./renderPublishBlocks.js";

const MARKER_PREFIX = "⟦IMG-";
const MARKER_SUFFIX = "⟧";

/** 1부터 시작하는 등장 순서의 표식. */
export function imageMarker(index: number): string {
  return `${MARKER_PREFIX}${index}${MARKER_SUFFIX}`;
}

/** 본문에 남은 표식을 찾는 정규식(업로드 후 잔재 청소용). */
export const ANY_IMAGE_MARKER = new RegExp(`${MARKER_PREFIX}\\d+${MARKER_SUFFIX}`, "g");

export type MarkedImage = {
  /** 본문에 박힌 표식 문자열. 에디터에서 이 텍스트를 찾아 그 자리에 업로드한다. */
  marker: string;
  url: string;
  /** 캡션 겸 대체 텍스트. 업로드 경로에서는 아직 쓰지 않는다(네이버 캡션 입력은 별도 UI). */
  alt: string;
};

export type MarkerExtraction = {
  /** 이미지 블록이 표식 줄로 바뀐 마크다운. */
  markdown: string;
  /** 등장 순서대로의 이미지 목록. */
  images: MarkedImage[];
};

/**
 * `![alt](url)` 한 줄 블록을 표식 줄로 바꾸고 이미지를 순서대로 모은다.
 *
 * 블록 단위로만 바꾼다 - 문단 가운데 섞인 이미지 문법은 건드리지 않는다(원고 규격상 이미지는
 * 항상 앞뒤 빈 줄을 둔 한 줄 블록이다, `rules/output-format.md`).
 */
export function extractImageMarkers(markdown: string): MarkerExtraction {
  const images: MarkedImage[] = [];

  const blocks = markdown.split(/\n{2,}/).map((block) => {
    const match = block.trim().match(IMAGE_LINE_PATTERN);
    if (!match) return block;
    const [, alt, url] = match;
    const marker = imageMarker(images.length + 1);
    images.push({ marker, url, alt });
    return marker;
  });

  return { markdown: blocks.join("\n\n"), images };
}
