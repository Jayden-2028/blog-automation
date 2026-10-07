// 카테고리/키워드 어휘를 기준으로 "이 후보를 파이프라인에 아예 들일지"를 판정한다.
//
// keywordCategoryRules.ts와의 역할 분담: 그 파일은 "카테고리가 무엇인가"만 판정하고, 이 파일은
// "그 카테고리·키워드를 수집 단계에서 걸러낼 것인가"를 판정한다 - 관심사가 다르다.
//
// 2026-09-07 채널 개편(사용자 결정)에서 도입:
// - 육아(parenting) 카테고리는 시스템 전체에서 완전히 제외한다. 수집 단계에서 원천 차단하기로
//   했다(원고화 단계에서 스킵하는 방식이 아니라, trend_candidates에 아예 안 쌓는다). classifyKeyword
//   Category의 parenting 규칙 자체는 지우지 않는다 - 나중에 재개할 때 어휘 리스트를 다시 짤 필요
//   없이 이 목록에서 한 줄만 빼면 된다.
// - 새 "사회 이슈" 카테고리(기존 incident/living)에서 정당·선거 등 정치 이슈는 배제한다. "국회"는
//   청원·상임위 심사처럼 정책·사회 이슈에도 자연스럽게 등장하므로(예: 캣맘 vs 새덕후 청원) 단독으로는
//   걸지 않는다 - 정당·선거 고유 어휘와 함께일 때만 정치로 판정한다.

import type { KeywordCategory } from "./keywordCategoryRules.js";

export const EXCLUDED_CATEGORIES: readonly KeywordCategory[] = ["parenting"];

export const POLITICAL_EXCLUSION_TERMS: readonly string[] = [
  "여당", "야당", "국민의힘", "더불어민주당", "민주당", "조국혁신당", "개혁신당", "진보당",
  "대선", "총선", "지방선거", "국회의원 선거", "국회의원선거", "탄핵", "특검", "국정감사",
  "여야", "당대표", "원내대표", "공천", "대통령실", "여의도",
];

export function isPoliticalKeyword(keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return false;
  return POLITICAL_EXCLUSION_TERMS.some((term) => normalized.includes(term.toLowerCase()));
}

// 스포츠(2026-10-07 사용자 결정): 엔터 트랙에 야구 기사(예: "키움 하현승 계약금")가 섞여 들어왔다.
// 종목명·리그명·구단 별칭으로 판정한다. 구단은 "두산·롯데·삼성·한화"처럼 기업명과 겹치는 단어를
// 피하고 별칭("트윈스" 등)만 쓴다. "키움"은 증권사와 겹쳐 예외를 둔다.
export const SPORTS_EXCLUSION_TERMS: readonly string[] = [
  "스포츠", "야구", "프로야구", "kbo", "mlb", "메이저리그", "축구", "k리그", "프리미어리그", "월드컵",
  "농구", "kbl", "wkbl", "nba", "배구", "v리그", "골프", "kpga", "klpga", "lpga", "pga", "테니스",
  "올림픽", "아시안게임", "ufc", "격투기", "마라톤", "컬링", "쇼트트랙", "피겨스케이팅",
  "트윈스", "자이언츠", "라이온즈", "이글스", "타이거즈", "랜더스", "다이노스", "베어스", "히어로즈", "키움",
  "손흥민", "이강인", "김민재", "오타니", "류현진", "김하성", "이정후", "김연아",
];

/** 스포츠 어휘를 포함하더라도 연예 프로그램 제목이라 통과시킬 표현. */
const SPORTS_EXCEPTION_TERMS: readonly string[] = [
  "최강야구", "골 때리는 그녀들", "골때녀", "뭉쳐야 찬다", "키움증권", "키움 증권",
];

export function isSportsKeyword(keyword: string): boolean {
  let normalized = keyword.trim().toLowerCase();
  if (!normalized) return false;
  for (const exception of SPORTS_EXCEPTION_TERMS) {
    normalized = normalized.split(exception.toLowerCase()).join(" ");
  }
  return SPORTS_EXCLUSION_TERMS.some((term) => normalized.includes(term.toLowerCase()));
}

export function isExcludedCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  return EXCLUDED_CATEGORIES.includes(category as KeywordCategory);
}

/** 이 후보(키워드+분류된 카테고리)를 수집 단계에서 버릴지 판정한다. */
export function shouldExcludeCandidate(
  keyword: string,
  category: string | null | undefined,
  seedQuery?: string | null
): boolean {
  // 기사 제목에는 구단·종목이 안 나와도(예: "투타겸업 하현승의 가치?") 찾아낸 시드 검색어에 있으면
  // 스포츠 기사다(2026-10-07) - 제목과 시드 검색어를 모두 본다.
  return (
    isExcludedCategory(category) ||
    isPoliticalKeyword(keyword) ||
    isSportsKeyword(keyword) ||
    (!!seedQuery && (isPoliticalKeyword(seedQuery) || isSportsKeyword(seedQuery)))
  );
}
