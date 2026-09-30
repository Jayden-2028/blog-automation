// 루리웹 베스트(bbs.ruliweb.com/best) HTML(문자열) -> 인기글 제목 목록 추출(순수 함수).
// parseTheqooHtml.ts와 같은 층위: fetch는 RuliwebProvider.ts가 맡고 여기는 파싱만 한다.
//
// 실제 DOM 구조(2026-09-30 실측, communityRecon.ts + communityProbe.ts로 확보):
// - 제목 anchor는 `a.subject_link`다. 실측 클래스는 `subject_link deco flex center`였지만
//   레이아웃용 유틸리티 클래스(deco/flex/center)는 디자인이 바뀌면 같이 바뀐다 - 의미를 담은
//   `subject_link` 하나만 선택자로 쓴다.
// - 행(tr)은 두 종류다. 상위 3건은 `tr.best_top_row`, 나머지는 `tr.mode_list`. 둘 다 인기글이라
//   구분 없이 모은다(더쿠의 tr.notice처럼 걸러야 할 공지 행은 이 페이지에 없었다).
// - anchor 텍스트는 순위·제목·댓글수가 한 줄로 합쳐져 나온다:
//     `1 현기차 4000~5000만원해도 사람들이 현기 사는 이유 (160)`   <- best_top_row(순위 있음)
//     `죽을때까지 고국에서 멸시받은 거장 (1)`                      <- mode_list(순위 없음)
//     `핫딜 [네이버]펩시 제로라임 355ml 48캔 (25,760원/무료) (7)`  <- 광고
//   그래서 텍스트를 정규화해서 순위·댓글수를 떼고 광고를 거른다. 내부 span 구조에 의존하지 않는
//   이유는 그쪽이 더 자주 바뀌기 때문이다.
//
// robots.txt 확인(2026-09-30): `User-agent: *`에 이 경로를 막는 규칙이 없다. 막는 것은
// /search, /timeline, /allbbs, /member와 쿼리 파라미터 패턴들이다.

import { parse, type HTMLElement } from "node-html-parser";
import type { CommunityPost } from "../CommunitySource.js";

export const RULIWEB_BEST_SELECTORS = {
  /** 레이아웃 유틸리티 클래스(deco/flex/center)는 일부러 뺐다 - 위 주석 참고. */
  titleAnchor: "a.subject_link",
  /** 순위가 붙는 상위 행. 이 행에서만 앞의 숫자를 순위로 취급한다. */
  topRowClass: "best_top_row",
} as const;

/** 목록 끝에 붙는 댓글 수. `암살자(들)`처럼 제목 안의 괄호는 숫자가 아니라 걸리지 않는다. */
const TRAILING_COMMENT_COUNT = /\s*\(\d[\d,]*\)\s*$/;

// 상위 행 맨 앞의 순위 숫자. 1~2자리 뒤에 공백이 오거나 거기서 문자열이 끝날 때만 뗀다.
// `$`를 넣은 이유: 제목이 비어 순위만 남은 행(`1 (160)` -> 댓글수 제거 후 `1`)에서 그 `1`이
// 제목으로 살아남는 걸 막는다. 아래에서 빈 문자열이 되어 null로 버려진다.
const LEADING_RANK = /^\d{1,2}(\s+|$)/;

/**
 * 광고/핫딜 행 표시. 루리웹 베스트는 제휴 딜을 같은 목록에 섞어 내보내며 제목 앞에 `핫딜`을
 * 붙인다. 이 프로젝트가 찾는 것은 "사람들이 지금 이야기하는 주제"이지 판매 정보가 아니라 제외한다.
 */
const PROMO_PREFIX = /^핫딜\s/;

function hasClass(element: HTMLElement, className: string): boolean {
  const classAttr = element.getAttribute("class");
  if (!classAttr) return false;
  return classAttr.split(/\s+/).includes(className);
}

/** anchor에서 가장 가까운 행(tr). 못 찾으면 null. */
function findRow(anchor: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = anchor.parentNode;
  while (current) {
    if (current.rawTagName?.toLowerCase() === "tr") return current;
    current = current.parentNode;
  }
  return null;
}

/**
 * anchor 텍스트에서 제목만 남긴다. 광고이거나 남는 게 없으면 null(호출자가 그 행을 버린다).
 *
 * 순위 제거를 상위 행에만 적용하는 이유: `2026 월드컵 예선` 같은 제목이 일반 행에 오면 앞의
 * 숫자를 순위로 오인해 잘라먹는다. 순위가 실제로 붙는 행에서만 떼면 그 위험이 사라진다.
 */
export function extractRuliwebTitle(rawText: string, isTopRow: boolean): string | null {
  let text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return null;

  text = text.replace(TRAILING_COMMENT_COUNT, "").trim();
  if (isTopRow) text = text.replace(LEADING_RANK, "").trim();

  if (PROMO_PREFIX.test(text)) return null;
  return text || null;
}

/**
 * 절대 throw하지 않는다(parseTheqooHtml.ts와 같은 "깨진 입력 -> 0건" 계약) - 페이지 구조가
 * 바뀌거나 차단 페이지가 오면 daily job이 아니라 이 함수가 조용히 0건을 반환해야 한다.
 * anchor 하나를 못 읽는 것은 그것만 건너뛰고 나머지는 계속 파싱한다.
 */
export function parseRuliwebBestHtml(html: string): CommunityPost[] {
  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return [];
  }

  const posts: CommunityPost[] = [];
  const seen = new Set<string>();
  let siteRank = 0;

  for (const anchor of root.querySelectorAll(RULIWEB_BEST_SELECTORS.titleAnchor)) {
    const row = findRow(anchor);
    const isTopRow = row ? hasClass(row, RULIWEB_BEST_SELECTORS.topRowClass) : false;

    const title = extractRuliwebTitle(anchor.text, isTopRow);
    if (!title) continue;
    // 같은 글이 상단 고정과 목록에 함께 나오는 경우가 있어 제목 기준으로 한 번만 센다.
    if (seen.has(title)) continue;

    seen.add(title);
    siteRank += 1;
    posts.push({ title, siteRank });
  }

  return posts;
}
