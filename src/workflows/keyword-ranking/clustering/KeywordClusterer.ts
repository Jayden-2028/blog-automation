// 동일 이슈로 보이는 후보들을 하나의 cluster로 묶기 위한 인터페이스.
// 초기 구현(TokenOverlapClusterer.ts)은 문자열 normalization + token overlap 기반이며,
// 이후 embedding/LLM 기반 구현으로 교체할 때도 이 인터페이스만 만족하면 되도록 분리해둔다.

export type KeywordCluster<T> = {
  /** cluster를 대표하는 키워드 문자열 (현재 구현은 가장 짧은 title을 사용). */
  representativeKeyword: string;
  items: T[];
};

// metadata는 선택적으로만 요구한다. CompositeSimilarityClusterer는 metadata.query(seed 검색어)가
// 있으면 그 토큰을 제외/저가중치 처리하는 데 사용하고, 없으면 생략하고 동작한다.
export interface KeywordClusterer {
  cluster<T extends { keyword: string; metadata?: Record<string, unknown> }>(
    items: T[]
  ): KeywordCluster<T>[];
}
