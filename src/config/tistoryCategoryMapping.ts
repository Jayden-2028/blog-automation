// 내부 category -> 티스토리 카테고리 **이름**(TISTORY_AUTO_PUBLISH_DESIGN.md §1).
//
// 티스토리 글쓰기 화면의 카테고리 목록(2026-10-06 실측, window.Config.blog.categories):
//   1585466 "왜 지금 이슈일까" · 1584397 "일상 생활 정보"
// id가 아니라 이름으로 고르는 이유: 발행기가 화면의 카테고리 목록(#category-btn -> #category-list)에서 글자로
// 찾아 누른다. 사용자가 티스토리에서 카테고리를 새로 만들거나 이름을 바꾸면 여기만 고치면 된다.
// 목록에 없는 이름이면 발행기는 카테고리를 건드리지 않고(티스토리 기본값) 경고만 남긴다.
//
// 사회 트랙은 incident / living / community 세 category만 온다(socialIssueKeywordJob). 생활·정책·경제는
// "일상 생활 정보", 사건사고·커뮤니티 화제는 "왜 지금 이슈일까"로 보낸다. 환경변수 TISTORY_DEFAULT_CATEGORY로
// 전부 한 카테고리에 몰 수도 있다.

export const TISTORY_CATEGORY_BY_INTERNAL: Readonly<Record<string, string>> = {
  incident: "왜 지금 이슈일까",
  community: "왜 지금 이슈일까",
  entertainment: "왜 지금 이슈일까",
  ott: "왜 지금 이슈일까",
  living: "일상 생활 정보",
  parenting: "일상 생활 정보",
};

export const TISTORY_FALLBACK_CATEGORY = "왜 지금 이슈일까";

/** 발행에 쓸 티스토리 카테고리 이름. null/모르는 category는 폴백. */
export function tistoryCategoryName(
  internalCategory: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  const forced = env.TISTORY_DEFAULT_CATEGORY?.trim();
  if (forced) return forced;
  if (!internalCategory) return TISTORY_FALLBACK_CATEGORY;
  return TISTORY_CATEGORY_BY_INTERNAL[internalCategory] ?? TISTORY_FALLBACK_CATEGORY;
}
