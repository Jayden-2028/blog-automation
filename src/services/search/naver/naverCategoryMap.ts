// 검색어별 기본 category 매핑. 뉴스/블로그/웹문서 provider가 공통으로 사용한다.
// provider별 options.categoryByQuery로 개별 생성 시 덮어쓸 수 있다.
export const DEFAULT_CATEGORY_BY_QUERY: Record<string, string> = {
  // OTT
  "넷플릭스": "ott",
  "디즈니플러스": "ott",
  "티빙": "ott",
  "웨이브": "ott",
  "쿠팡플레이": "ott",

  // 육아
  "육아지원금": "parenting",
  "출산지원금": "parenting",
  "부모급여": "parenting",
  "아동수당": "parenting",

  // 생활/정책
  "정부지원금": "living",
  "날씨": "living",
  "전기요금": "living",
  "교통비": "living",
  "정책변화": "living",

  // 연예
  "연예": "entertainment",
  "배우": "entertainment",
  "아이돌": "entertainment",
  "드라마": "entertainment",
  "영화": "movie",
};
