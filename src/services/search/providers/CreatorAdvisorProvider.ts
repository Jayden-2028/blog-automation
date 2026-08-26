// NAVER Creator Advisor 트렌드 탭에서 topic별 인기/유입 가능성이 높은 검색 키워드를 가져오는
// provider 공통 인터페이스. 기존 KeywordProvider(뉴스/블로그/웹문서 검색)와는 응답 구조가 전혀 달라
// (rank/rankChange 등 트렌드 고유 필드), 별도 인터페이스로 분리한다 — NaverTrendProvider가
// KeywordProvider를 억지로 구현하지 않은 것과 같은 이유.

/**
 * .u_ni_data의 classList를 1차 신호로 판정한 등락 상태(실제 DOM 확인 완료, 2026-08-26).
 * up/down/new 중 아무 class도 없으면 flat(변동 없음)이다. 화면의 ▲/▼ 문자에는 의존하지 않는다.
 */
export type CreatorAdvisorMovementType = "up" | "down" | "new" | "flat";

export type CreatorAdvisorTrendCandidate = {
  keyword: string;
  /** trends 페이지 topic card의 실제 표시 제목 원문 (예: "스타·연예인"). 페이지가 주는 그대로 사용한다. */
  topic: string;
  /** topic card 내 .u_ni_trend_item 순서 기반 순위(1-based). */
  rank: number;
  movementType: CreatorAdvisorMovementType;
  /** rank + rankChange로 계산. movementType="new"면 null(직전 순위 없음). */
  previousRank: number | null;
  /** up=양수, down=음수, new=null, flat=0. */
  rankChange: number | null;
  /** 이 후보를 수집한 시각 (ISO 8601). */
  collectedAt: string;
  metadata: Record<string, unknown>;
};

export type FetchTrendKeywordsOptions = {
  /** 수집할 최대 topic card 개수. 생략하면 provider 생성 시 설정된 기본값(CREATOR_ADVISOR_CONFIG.maxTopics)을 사용한다. */
  maxTopics?: number;
  /** topic당 반환할 최대 키워드 개수. 생략하면 provider 생성 시 설정된 기본값을 사용한다. */
  maxKeywordsPerTopic?: number;
};

export interface CreatorAdvisorProvider {
  fetchTrendKeywords(options?: FetchTrendKeywordsOptions): Promise<CreatorAdvisorTrendCandidate[]>;
}
