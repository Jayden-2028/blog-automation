// 파이프라인 카테고리 -> 네이버 블로그(whyissuenow) 카테고리 번호 매핑(2026-09-22 사용자 결정).
//
// 번호는 추측이 아니라 실측이다 - 로그인된 세션으로 blog.naver.com/whyissuenow를 열어
// `a[href*='categoryNo=']`를 프레임 전체에서 긁어 확인했다. 블로그에서 카테고리를 바꾸면
// 번호도 바뀔 수 있으므로, 발행이 엉뚱한 카테고리로 들어가면 여기부터 다시 읽어야 한다.
//
// 실측된 카테고리(2026-09-22):
//    1 지금 뜨는 이슈 / 6 정책·사회 / 7 경제·테크 / 8 문화·생활 / 9 일상·팁 / 11 스포츠·연예인
//   (0은 "전체보기"라 실제 카테고리가 아니다 - 여기에 발행하면 안 된다)
//
// 7(경제·테크)과 8(문화·생활)은 지금 우리 카테고리와 대응하는 것이 없어 비워 둔다.
// 해당 주제를 다루게 되면 그때 붙인다.

/** 미분류·새 카테고리가 들어올 때 쓰는 기본값. "지금 뜨는 이슈"가 가장 넓게 받는다. */
export const NAVER_DEFAULT_CATEGORY_NO = 1;

/**
 * job.category -> categoryNo.
 *
 * 키는 `article_jobs.category`에 실제로 저장되는 값이다(소문자). DB 실측 기준으로
 * living / entertainment / ott / incident / community / parenting 여섯 가지가 쓰인다.
 */
export const NAVER_CATEGORY_NO: Record<string, number> = {
  living: 9, // 일상·팁 (사용자 결정 - 문화·생활보다 이쪽이 맞다)
  parenting: 9, // 일상·팁
  entertainment: 11, // 스포츠·연예인
  ott: 11, // 스포츠·연예인
  incident: 6, // 정책·사회
  community: 1, // 지금 뜨는 이슈
};

/** 대소문자·공백 차이로 매핑이 빗나가지 않게 정규화해서 찾는다. */
export function naverCategoryNo(category: string | null | undefined): number {
  if (!category) return NAVER_DEFAULT_CATEGORY_NO;
  return NAVER_CATEGORY_NO[category.trim().toLowerCase()] ?? NAVER_DEFAULT_CATEGORY_NO;
}
