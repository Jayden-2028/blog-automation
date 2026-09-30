// 에펨코리아 베스트(fmkorea.com/best) HTML(문자열) -> 인기글 제목 목록 추출(순수 함수).
// parseTheqooHtml.ts / parseRuliwebHtml.ts와 같은 층위: fetch는 FmkoreaProvider.ts가 맡는다.
//
// 실제 DOM 구조(2026-10-01 실측, communityRecon.ts + communityProbe.ts --raw로 확보):
//
//   <li class="li li_best2_pop1 li_best2_hotdeal0 li_best2_politics0">
//     <div class="li">
//       <a class="pc_voted_count ..."><span class="count">1237</span></a>   <- 추천수
//       <h3 class="title">
//         <a href="/index.php?...document_srl=10395586779" class=" hotdeal_var8">
//           <span class="ellipsis-target">제목</span>&nbsp;
//           <span class="comment_count">[350]</span>
//         </a>
//       </h3>
//       <div><span class="category"><a href="/humor">유머</a></span>
//            <span class="regdate">3 시간 전</span><span class="author">/ 천량</span></div>
//
// **제목 anchor의 클래스(`hotdeal_var8`)는 일부러 쓰지 않는다.** 뜻을 알 수 없는 이름이라
// 난독화이거나 목록 스타일 변형 번호로 보이는데, 어느 쪽이든 바뀌면 파서가 조용히 0건이 된다.
// 대신 의미가 분명한 `h3.title`과 `span.ellipsis-target`을 쓴다 - 후자에는 순위도 댓글수도 섞이지
// 않은 제목만 들어 있어, 루리웹처럼 정규식으로 떼어낼 필요조차 없다.
//
// 행(li)의 클래스는 사이트가 스스로 붙인 의미 플래그다(사용자에게 "핫딜 숨기기" 같은 토글을
// 주려는 것으로 보인다). 이 두 가지를 그대로 쓴다:
//   - li_best2_hotdeal1  = 제휴 딜/광고        -> 제외(우리가 찾는 건 판매 정보가 아니다)
//   - li_best2_politics1 = 정치글              -> 제외(이 프로젝트는 정치 키워드를 수집하지 않는다.
//                                                지금은 excludeCandidateInserts가 키워드 어휘로
//                                                걸러내는데, 여기서는 사이트가 붙여준 플래그로
//                                                수집 단계에서 먼저 뺄 수 있다)
//
// robots.txt 확인(2026-09-30): `User-agent: *`에 `Disallow: /`와 함께 `Allow: /best`, `Allow: /best2`가
// 있다 - 사이트가 이 두 경로만 의도적으로 열어뒀다. AI 크롤러 40여 개는 이름으로 차단하지만
// 기본 UA는 위 규칙을 따른다. 쿼리 파라미터 경로(`/*listStyle=` 등)는 막혀 있어 건드리지 않는다.

import { parse, type HTMLElement } from "node-html-parser";
import type { CommunityPost } from "../CommunitySource.js";

export const FMKOREA_BEST_SELECTORS = {
  /** 인기글 행. 클래스 플래그(li_best2_*)가 붙는 바깥쪽 li다. */
  row: "li.li",
  /** 제목 anchor를 감싸는 헤딩. 의미가 분명해 난독화 의심 클래스 대신 이걸 쓴다. */
  titleHeading: "h3.title",
  /** 제목 텍스트만 들어 있는 span. 순위·댓글수가 섞이지 않는다. */
  titleText: "span.ellipsis-target",
  /** 제목 anchor 안에 제목과 나란히 있는 댓글 수(`[350]`). 폴백 경로에서 떼어낸다. */
  commentCount: "span.comment_count",
} as const;

/** 사이트가 행에 붙이는 제외 플래그. 값이 1이면 해당 분류라는 뜻이다. */
export const FMKOREA_SKIP_ROW_CLASSES = ["li_best2_hotdeal1", "li_best2_politics1"] as const;

/** 폴백 경로에서만 쓴다. 제목 끝의 `[350]` 형태 댓글 수. */
const TRAILING_COMMENT_COUNT = /\s*\[\d[\d,]*\]\s*$/;

function rowClasses(row: HTMLElement): string[] {
  const classAttr = row.getAttribute("class");
  return classAttr ? classAttr.split(/\s+/).filter(Boolean) : [];
}

/**
 * 제목 텍스트를 꺼낸다. 기본 경로는 span.ellipsis-target이고, 그게 없으면 anchor 전체 텍스트에서
 * 댓글 수 span을 뗀 값을 쓴다. 폴백을 두는 이유: ellipsis 처리는 화면 표시용이라 레이아웃이
 * 바뀌면 사라질 수 있는데, 그때 파서가 통째로 0건이 되는 것보다는 조금 지저분해도 제목을 얻는 게 낫다.
 */
export function extractFmkoreaTitle(heading: HTMLElement): string | null {
  const exact = heading.querySelector(FMKOREA_BEST_SELECTORS.titleText);
  if (exact) {
    const text = exact.text.replace(/\s+/g, " ").trim();
    if (text) return text;
  }

  const anchor = heading.querySelector("a");
  if (!anchor) return null;

  // 댓글 수 span을 제거한 뒤 남는 텍스트. 제거가 안 되면 정규식으로 한 번 더 떼어낸다.
  const counts = anchor.querySelectorAll(FMKOREA_BEST_SELECTORS.commentCount);
  const countTexts = counts.map((node) => node.text.replace(/\s+/g, " ").trim()).filter(Boolean);

  let text = anchor.text.replace(/\s+/g, " ").trim();
  for (const countText of countTexts) text = text.split(countText).join(" ");
  text = text.replace(/\s+/g, " ").trim().replace(TRAILING_COMMENT_COUNT, "").trim();

  return text || null;
}

/**
 * 절대 throw하지 않는다(parseTheqooHtml.ts와 같은 "깨진 입력 -> 0건" 계약). 페이지 구조가 바뀌거나
 * 차단 페이지가 오면 daily job이 아니라 이 함수가 조용히 0건을 반환해야 한다.
 */
export function parseFmkoreaBestHtml(html: string): CommunityPost[] {
  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return [];
  }

  const posts: CommunityPost[] = [];
  const seen = new Set<string>();
  let siteRank = 0;

  for (const row of root.querySelectorAll(FMKOREA_BEST_SELECTORS.row)) {
    const classes = rowClasses(row);
    if (FMKOREA_SKIP_ROW_CLASSES.some((skip) => classes.includes(skip))) continue;

    const heading = row.querySelector(FMKOREA_BEST_SELECTORS.titleHeading);
    if (!heading) continue;

    const title = extractFmkoreaTitle(heading);
    if (!title) continue;
    // 같은 글이 상단 인기 블록과 일반 목록에 함께 나오는 경우가 있다(광고가 특히 그렇다).
    if (seen.has(title)) continue;

    seen.add(title);
    siteRank += 1;
    posts.push({ title, siteRank });
  }

  return posts;
}
