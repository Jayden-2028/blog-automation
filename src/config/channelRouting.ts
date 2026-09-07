// 카테고리 -> 발행 채널(티스토리/블로그스팟) 배정(2026-09-07 채널 개편, 사용자 승인).
//
// 배경: 예전에는 카테고리와 무관하게 승인된 job 1건마다 네이버(기준)+티스토리(배리에이션)+
// 블로그스팟(배리에이션) 3채널을 전부 만들었다. 이제 채널을 주제별로 전담시킨다 - 네이버는 이번
// 개편에서 완전히 뺀다(사용자가 별도 프로세스로 재설계 예정, 코드는 건드리지 않고 dormant 유지).
//
// - 티스토리: 사회·문화 이슈/사건사고/경제·정책 (기존 incident + living 카테고리)
// - 블로그스팟: 연예계 가십 + 영화·드라마·예능·OTT (기존 entertainment + ott 카테고리)
// - 커뮤니티 화제(community): 내용 기반으로 둘 중 하나에 배정(아래 classifyCommunityChannel)
// - 육아(parenting): 수집 단계에서 이미 걸러져(keywordExclusionRules.ts) 여기 도달하지 않는다.
//   혹시 도달해도(과거에 이미 만들어진 job 등) 채널을 배정하지 않는다 - 아래 표에 없으므로 null.

import type { KeywordCategory } from "./keywordCategoryRules.js";

export type PublishChannel = "tistory" | "blogspot";

const CATEGORY_TO_CHANNEL: Partial<Record<KeywordCategory, PublishChannel>> = {
  incident: "tistory",
  living: "tistory",
  entertainment: "blogspot",
  ott: "blogspot",
};

// community로 분류된 키워드 중, 인물 개인의 가십·사생활 이슈에 가까운 어휘가 있으면 블로그스팟으로
// 보낸다. 그 외(사회적 논쟁·여론·청원 등)는 기본값 티스토리 - keywordCategoryRules.ts의 entertainment/
// ott 규칙이 이미 연예인/작품 관련 어휘를 먼저 걸러내므로, community까지 남는 항목은 대부분
// 사회형 잔여다(trend.md의 "인물보다 논쟁 자체" 방향과도 일치). 실제 운영 데이터로 이 어휘 목록을
// 다듬는 건 keywordCategoryRules.ts와 같은 방식으로 계속한다.
const COMMUNITY_BLOGSPOT_TERMS: readonly string[] = [
  "인플루언서", "유튜버", "bj", "스트리머", "사생활 논란", "열애", "결별", "이혼설", "탈덕", "asmr",
];

export function classifyCommunityChannel(keyword: string): PublishChannel {
  const normalized = keyword.trim().toLowerCase();
  const isGossipLeaning = COMMUNITY_BLOGSPOT_TERMS.some((term) => normalized.includes(term));
  return isGossipLeaning ? "blogspot" : "tistory";
}

/**
 * 카테고리(+커뮤니티는 키워드까지)로 발행 채널을 정한다. 배정표에 없는 카테고리(parenting 등)면
 * null - 호출자가 "이 job은 채널이 없다"는 뜻으로 처리해야 한다.
 */
export function resolvePublishChannel(
  category: string | null | undefined,
  keyword: string
): PublishChannel | null {
  if (!category) return null;
  if (category === "community") return classifyCommunityChannel(keyword);
  return CATEGORY_TO_CHANNEL[category as KeywordCategory] ?? null;
}
