// 더쿠 핫게시판(theqoo.net/hot) HTML(문자열) -> 인기글 제목 목록 추출(순수 함수).
// parseTrendHtml.ts(Creator Advisor)와 같은 층위: fetch/네트워크는 TheqooProvider.ts가 맡고,
// 여기는 파싱만 한다.
//
// 실제 DOM 구조(2026-08-30 실측 확인, communityRecon.ts + communityProbe.ts로 확보):
// - 목록은 <tr> row 단위다. row 하나에 제목 anchor 1개 + 추천수(숫자만) anchor 1개가 둘 다
//   `td.title > a`로 잡힌다 - class로는 둘을 구분할 수 없어 **텍스트가 숫자뿐인지**로 가른다.
// - **상단 고정 공지(운영 공지/이용 규칙 등)는 `tr.notice`(+ nofn/nofnhide 등 부가 modifier)를
//   갖고, 실제 인기글 row는 class 속성 자체가 없다.** 이게 공지와 일반 글을 가르는 유일한 신호다
//   (실측 46개 anchor 중 상위 6개 title 텍스트가 전부 tr.notice였고, 그 뒤로는 전부 무-class).
// - robots.txt에 disallow가 없어(2026-08-30 확인) 이 목록 페이지는 스크래핑 가능하다. 나머지 세
//   후보 사이트(네이트판/다음카페/네이버카페)는 robots.txt가 정확히 그 목록 경로를 금지해 제외했다
//   (CommunitySource.ts, KEYWORD_SOURCE_EXPANSION.md §7-2).

import { parse, type HTMLElement } from "node-html-parser";
import type { CommunityPost } from "../CommunitySource.js";

export const THEQOO_HOT_SELECTORS = {
  row: "tr",
  titleCell: "td.title a",
  noticeRowClass: "notice",
} as const;

function isNoticeRow(row: HTMLElement): boolean {
  const classAttr = row.getAttribute("class");
  if (!classAttr) return false;
  return classAttr.split(/\s+/).includes(THEQOO_HOT_SELECTORS.noticeRowClass);
}

function isPureNumber(text: string): boolean {
  return /^[\d,]+$/.test(text);
}

/**
 * row 하나 안의 td.title > a 여러 개(제목 + 추천수) 중 제목 anchor를 고른다.
 * 숫자만 있는 텍스트(추천수 배지)는 건너뛴다. 못 찾으면 null(그 row는 버린다 - card 하나 실패가
 * 전체를 막지 않는 parseTrendHtml.ts의 원칙과 같다).
 */
function extractTitle(row: HTMLElement): string | null {
  const anchors = row.querySelectorAll(THEQOO_HOT_SELECTORS.titleCell);
  for (const anchor of anchors) {
    const text = anchor.text.replace(/\s+/g, " ").trim();
    if (text && !isPureNumber(text)) return text;
  }
  return null;
}

/**
 * 절대 throw하지 않는다(mapGoogleTrendsCandidates.ts 등과 같은 "깨진 입력 -> 0건" 계약) - 페이지
 * 구조가 바뀌거나 차단 페이지가 오면 daily job이 아니라 이 함수가 조용히 0건을 반환해야 한다.
 * row 하나를 못 읽는 것은(제목 anchor 없음 등) 그 row만 건너뛰고 나머지는 계속 파싱한다.
 */
export function parseTheqooHotHtml(html: string): CommunityPost[] {
  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return [];
  }

  const posts: CommunityPost[] = [];
  let siteRank = 0;

  for (const row of root.querySelectorAll(THEQOO_HOT_SELECTORS.row)) {
    if (isNoticeRow(row)) continue;

    const title = extractTitle(row);
    if (!title) continue;

    siteRank += 1;
    posts.push({ title, siteRank });
  }

  return posts;
}
