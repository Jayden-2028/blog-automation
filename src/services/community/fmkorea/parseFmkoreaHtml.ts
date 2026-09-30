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

/**
 * 플래그가 놓치는 제휴 딜을 잡는 2차 그물(2026-10-01 실측에서 확인).
 * `[쿠팡로켓프레시] 풀무원 평양왕만두 (냉동), 490g, 6개 (16,140원) (로켓프레시)` 같은 글이
 * 핫딜 게시판 밖에 올라오면 `li_best2_hotdeal0`으로 나온다.
 *
 * **대괄호 쇼핑몰 표기와 괄호 안 가격을 둘 다** 요구한다. 둘 중 하나만 보면 오폭한다 -
 * `[BNT] 불가리아 1부 구단주 피살`처럼 대괄호로 시작하는 기사 제목이 실제로 있고, 가격만 보면
 * `월세 (50만원) 실화냐` 같은 일반 글이 걸린다. 딜 글은 거의 항상 둘 다 갖는다.
 */
const PROMO_SHOP_PREFIX = /^\[[^\]]+\]/;
const PROMO_PRICE = /\([\d,]+\s*원/;

function looksLikeDealPost(title: string): boolean {
  return PROMO_SHOP_PREFIX.test(title) && PROMO_PRICE.test(title);
}

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
  // 같은 글이 상단 인기 블록과 일반 목록에 함께 나오는 경우가 있다(광고가 특히 그렇다).
  // **제외한 제목도 여기 담는다.** 실측에서 같은 광고가 두 번 나오는데 한쪽에만 hotdeal1이
  // 붙어 있었다 - 제외한 쪽을 기억하지 않으면 플래그 없는 사본이 그대로 통과한다.
  const seen = new Set<string>();
  let siteRank = 0;

  for (const row of root.querySelectorAll(FMKOREA_BEST_SELECTORS.row)) {
    const heading = row.querySelector(FMKOREA_BEST_SELECTORS.titleHeading);
    if (!heading) continue;

    const title = extractFmkoreaTitle(heading);
    if (!title) continue;
    if (seen.has(title)) continue;

    // 제목을 먼저 뽑고 나서 제외를 판단한다 - 순서가 바뀌면 제외한 제목을 기억할 수 없다.
    const classes = rowClasses(row);
    const excluded =
      FMKOREA_SKIP_ROW_CLASSES.some((skip) => classes.includes(skip)) || looksLikeDealPost(title);

    seen.add(title);
    if (excluded) continue;

    siteRank += 1;
    posts.push({ title, siteRank });
  }

  return posts;
}
