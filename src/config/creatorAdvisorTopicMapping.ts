// Creator Advisor의 실제 topic card 제목 -> 내부 category(trend_candidates.topic_normalized) 매핑.
//
// 원본 topic은 trend_candidates.topic에 항상 그대로 보존된다 - 이 매핑은 topic_normalized에만
// 반영되고, 원본을 대체하지 않는다.
//
// 기존 seed_queries/scoring 파이프라인이 이미 쓰고 있는 4개 category(ott/parenting/living/
// entertainment - config/keywordScoring.ts의 DIVERSITY_CONFIG.targetCategories,
// supabase/migrations/20260825140000_seed_queries_initial_data.sql 참고)만 사용한다. 무리하게
// 새 category(예: "travel", "tech", "food")를 만들지 않고, 기존 4개 안에서 가장 가까운 것으로
// 묶었다 - 실제 활용도가 확인되면 그때 세분화하는 게 안전하다.
//
// 매핑 근거(2026-08-26 실측 확인된 11개 topic 기준):
// - 육아·결혼 -> parenting (그대로)
// - 방송, 스타·연예인 -> entertainment (연예/방송/가십)
// - 드라마, 영화 -> ott (OTT/영화/드라마)
// - 일상·생각, 비즈니스·경제, 국내여행, 세계여행, IT·컴퓨터, 요리·레시피 -> living
//   (생활정보 계열로 통칭 - 기존 category가 이 세분화까지 지원하지 않는다)
export const CREATOR_ADVISOR_TOPIC_CATEGORY_MAP: Record<string, string> = {
  "육아·결혼": "parenting",
  "방송": "entertainment",
  "스타·연예인": "entertainment",
  "드라마": "ott",
  "영화": "ott",
  "일상·생각": "living",
  "비즈니스·경제": "living",
  "국내여행": "living",
  "세계여행": "living",
  "IT·컴퓨터": "living",
  "요리·레시피": "living",
};

/**
 * topic 원문 -> 내부 category. 매핑표에 없는 topic(향후 Naver가 카테고리를 추가/변경한 경우)은
 * lower(trim(topic))로 대체한다 - 알 수 없는 topic이라고 파이프라인을 막지 않는다.
 */
export function mapCreatorAdvisorTopicToCategory(topic: string): string {
  return CREATOR_ADVISOR_TOPIC_CATEGORY_MAP[topic] ?? topic.trim().toLowerCase();
}
