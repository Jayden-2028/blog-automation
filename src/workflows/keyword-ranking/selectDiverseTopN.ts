// scoring이 끝난 cluster 목록(점수 내림차순) 중 Top N을 고를 때, 특정 seedQuery/주제로
// 도배되지 않도록 diversity 제약을 적용하는 최종 selection 단계.
//
// 규칙(DIVERSITY_CONFIG, config로 조절 가능):
// 1) 동일 seedQuery는 최대 maxPerSeedQuery개까지만.
//    단 seedQuery가 분류어(넷플릭스/티빙/지원금 등 TOPIC_GROUPING_CONFIG.categoryTerms +
//    그날의 seed_queries)면 이 cap을 적용하지 않는다 - "넷플릭스" 하나에 서로 다른 작품 2편이
//    묶이면 안 되기 때문이다(topicGrouping과 같은 철학). 실제 도배는 "황재균 지연", "상생페이백
//    사용"처럼 구체적인 seedQuery에서 같은 사건 기사 2건이 나오는 경우이고, 이건 여전히 막는다.
// 2) 동일 topic은 최대 maxPerCanonicalTopic개까지만.
//    "동일 topic"은 canonical keyword 문자열 완전 일치가 아니라 topicGrouping.ts의 isSameTopic()으로
//    판정한다 - 같은 이슈라도 제목이 다르면 canonical이 달라져 cap이 발화하지 않던 문제 때문이다
//    (2026-08-29: "넷플릭스 들쥐"가 서로 다른 canonical 4개로 Top 10을 4칸 차지). 판정 근거와
//    clustering이 이 상황을 왜 놓치는지는 topicGrouping.ts 상단 주석에 정리돼 있다.
//    DIVERSITY_CONFIG.enableTopicGrouping=false면 예전처럼 문자열 완전 일치로만 센다.
// 3) enableCategoryBackfill이 true면, targetCategories 중 Top N에 대표가 없는 category를
//    candidate pool에서 찾아 채운다 — 단, 그 category에 해당하는 candidate가 pool에 아예 없으면
//    억지로 채우지 않는다(실제 고점 이슈가 없는 category를 낮은 점수로 강제 편입하지 않기 위함).
//
// topic 판정에는 headline(원문 제목)이 있으면 그쪽을 쓴다. canonical keyword는 앞에서부터 잘라낸
// 축약이라 뒤쪽 고유명사가 이미 사라진 경우가 있어, 주제 판정 근거로는 원문이 더 안전하다.

import { DIVERSITY_CONFIG, TOPIC_GROUPING_CONFIG } from "../../config/keywordScoring.js";
import { buildTopicIndex } from "./topicGrouping.js";

export type DiversityCandidate = {
  keyword: string;
  /** cluster 대표 원문 제목. 있으면 topic 판정에 우선 사용한다. */
  headline?: string | null;
  seedQuery: string | null;
  category: string;
  totalScore: number;
};

export type SelectDiverseTopNOptions = {
  /**
   * 이번 run에서 "분류어"로 취급할 단어(주제 판정 신호에서 제외된다). daily workflow는 seed_queries
   * 유래 query만 넘긴다 - Creator Advisor에서 온 그날의 화제 키워드는 주제 그 자체이므로 넘기지 않는다.
   * topicGrouping.ts의 BuildTopicIndexOptions.extraCategoryTerms 참고.
   */
  categoryTerms?: readonly string[];
};

export function selectDiverseTopN<T extends DiversityCandidate>(
  sortedByScoreDesc: T[],
  topN: number,
  options: SelectDiverseTopNOptions = {}
): T[] {
  const seedQueryCounts = new Map<string, number>();
  const selected: T[] = [];
  const selectedSet = new Set<T>();

  // df 기반 희소성 판정이 의미를 가지려면 Top N으로 자르기 전 batch 전체를 봐야 한다.
  const topicIndex = buildTopicIndex(sortedByScoreDesc, (item) => item.headline || item.keyword, {
    extraCategoryTerms: options.categoryTerms,
  });

  // 분류어로 취급할 seedQuery(고정 목록 + 그날의 seed_queries). 이 seedQuery에는 maxPerSeedQuery를
  // 적용하지 않는다 - "넷플릭스" 하나에 서로 다른 작품이 묶이는 것을 막기 위함.
  const classifierSeedTerms = new Set(
    [...TOPIC_GROUPING_CONFIG.categoryTerms, ...(options.categoryTerms ?? [])].map((term) => term.trim().toLowerCase())
  );
  const isClassifierSeed = (seedQuery: string): boolean => classifierSeedTerms.has(seedQuery.trim().toLowerCase());

  const sameTopicCount = (item: T): number => {
    let count = 0;
    for (const other of selected) {
      const isSame = DIVERSITY_CONFIG.enableTopicGrouping
        ? topicIndex.isSameTopic(item, other)
        : item.keyword === other.keyword;
      if (isSame) count++;
    }
    return count;
  };

  // 특정 category가 Top N을 잠식하는 것을 막는 상한(DIVERSITY_CONFIG.maxPerCategory).
  // 예: 정부지원금·정책 키워드는 서로 다른 주제(핵심 명사 공유 없음)라 maxPerCanonicalTopic이
  // 발화하지 않고, seedQuery도 없는 경우가 많아 maxPerSeedQuery도 못 막는다. 이 키워드들이 전부
  // living으로 분류되므로 living 상한으로 잡는다. selected에서 직접 센다(backfill 교체에도 일관).
  const categoryCount = (category: string): number =>
    selected.reduce((count, other) => count + (other.category === category ? 1 : 0), 0);

  const canSelect = (item: T): boolean => {
    if (
      item.seedQuery &&
      !isClassifierSeed(item.seedQuery) &&
      (seedQueryCounts.get(item.seedQuery) ?? 0) >= DIVERSITY_CONFIG.maxPerSeedQuery
    ) {
      return false;
    }
    if (sameTopicCount(item) >= DIVERSITY_CONFIG.maxPerCanonicalTopic) {
      return false;
    }
    const categoryCap = DIVERSITY_CONFIG.maxPerCategory[item.category];
    if (categoryCap !== undefined && categoryCount(item.category) >= categoryCap) {
      return false;
    }
    return true;
  };

  const markSelected = (item: T): void => {
    selected.push(item);
    selectedSet.add(item);
    if (item.seedQuery) {
      seedQueryCounts.set(item.seedQuery, (seedQueryCounts.get(item.seedQuery) ?? 0) + 1);
    }
  };

  // 1) 점수 순으로 훑으며 seedQuery/topic/category cap을 지키는 선에서 greedy하게 채운다.
  for (const item of sortedByScoreDesc) {
    if (selected.length >= topN) break;
    if (canSelect(item)) markSelected(item);
  }

  // 1-1) category cap 때문에 Top N을 못 채웠으면(후보가 얕은 날), category cap만 풀고 다시 채운다.
  //      seedQuery/topic 중복은 여전히 막는다 - "빈 자리를 남기느니 같은 계열이라도 채운다".
  if (selected.length < topN) {
    for (const item of sortedByScoreDesc) {
      if (selected.length >= topN) break;
      if (selectedSet.has(item)) continue;
      const withinSeedCap =
        !item.seedQuery ||
        isClassifierSeed(item.seedQuery) ||
        (seedQueryCounts.get(item.seedQuery) ?? 0) < DIVERSITY_CONFIG.maxPerSeedQuery;
      if (withinSeedCap && sameTopicCount(item) < DIVERSITY_CONFIG.maxPerCanonicalTopic) {
        markSelected(item);
      }
    }
  }

  // 2) category backfill: 대표가 없는 target category에 대해, cap을 지키는 candidate가 pool에 있으면
  //    현재 selection에서 "다른 target category의 유일한 대표가 아닌" 최저점 항목과 교체한다.
  if (DIVERSITY_CONFIG.enableCategoryBackfill) {
    for (const category of DIVERSITY_CONFIG.targetCategories) {
      const alreadyRepresented = selected.some((item) => item.category === category);
      if (alreadyRepresented) continue;

      const candidate = sortedByScoreDesc.find(
        (item) => item.category === category && !selectedSet.has(item) && canSelect(item)
      );
      // 이 category는 candidate pool 자체에 없거나 cap에 걸림 -> 실제 고점 이슈가 없는 것으로 보고 넘어간다.
      if (!candidate) continue;

      const removalCandidates = selected
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => {
          const isSoleRepresentativeOfTargetCategory =
            DIVERSITY_CONFIG.targetCategories.includes(item.category) &&
            selected.filter((other) => other.category === item.category).length === 1;
          return !isSoleRepresentativeOfTargetCategory;
        })
        .sort((a, b) => a.item.totalScore - b.item.totalScore);

      const toRemove = removalCandidates[0];
      if (!toRemove) continue; // 교체 가능한 슬롯이 없음(예: 전부 target category 유일 대표) -> 포기.

      const removed = toRemove.item;
      selectedSet.delete(removed);
      if (removed.seedQuery) {
        seedQueryCounts.set(removed.seedQuery, Math.max(0, (seedQueryCounts.get(removed.seedQuery) ?? 1) - 1));
      }

      selected[toRemove.index] = candidate;
      selectedSet.add(candidate);
      if (candidate.seedQuery) {
        seedQueryCounts.set(candidate.seedQuery, (seedQueryCounts.get(candidate.seedQuery) ?? 0) + 1);
      }
    }
  }

  return selected.sort((a, b) => b.totalScore - a.totalScore);
}
