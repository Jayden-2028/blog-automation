// og:description에서 읽은 캡션의 군더더기를 벗긴다(2026-09-23).
//
// 왜 필요해졌나: 예전에는 사용자가 텔레그램에 캡션을 직접 붙여넣어 이 문제가 안 보였다. 링크만
// 받는 설계로 바뀌면서 캡션은 전부 게시물에서 긁어오는데, 인스타의 og:description은 링크
// 미리보기용이라 앞에 지표와 계정·날짜가 붙는다(2026-09-23 실측):
//
//   1,032 likes, 7 comments - wpedia.magazine - September 7, 2026: "이나영, 이옥섭 감독 신작..."
//   focuspic.kr - September 9, 2026: "허진호 감독의 영화 <암살자(들)>이..."
//
// 그대로 조사 프롬프트에 넣으면 "1,032 likes"나 계정명이 주제어 후보로 섞인다. 본문만 남긴다.

/** `123 likes, 4 comments - ` 앞머리. 좋아요/댓글 수가 없는 게시물도 있어 통째로 선택적이다. */
const METRICS = /^\s*[\d,.]+\s*(?:likes?|좋아요)\s*(?:,\s*[\d,.]+\s*(?:comments?|댓글)\s*)?[-–—]\s*/i;

/** `계정명 - September 7, 2026: ` 또는 `계정명 - 2026년 9월 7일: ` 앞머리. */
const HANDLE_AND_DATE = /^\s*[^\s:][^:]{0,80}?\s*[-–—]\s*[^:]{0,40}?\d{4}[^:]{0,20}?:\s*/;

/** 본문을 감싼 바깥쪽 따옴표 한 쌍. 안쪽 따옴표는 캡션의 일부라 건드리지 않는다. */
const WRAPPING_QUOTES = /^\s*["“”'']([\s\S]*)["“”'']\s*$/;

/**
 * og:description을 사람이 쓴 캡션 본문으로 되돌린다.
 *
 * 벗길 게 없으면 원문을 그대로 돌려준다 - 형식이 바뀌어 정규식이 빗나가도 캡션을 통째로
 * 잃지는 않는다. 자료가 0이 되는 것보다 군더더기가 남는 편이 낫다.
 */
export function cleanCaption(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  text = text.replace(METRICS, "");
  text = text.replace(HANDLE_AND_DATE, "");

  const unwrapped = text.match(WRAPPING_QUOTES);
  if (unwrapped) text = unwrapped[1];

  // 인스타는 줄바꿈을 그대로 준다. 빈 줄이 여러 개 이어지면 하나로 줄인다.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
