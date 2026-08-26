// scoring이 끝난 cluster 목록(점수 내림차순) 중 Top N을 고를 때, 특정 seedQuery/canonical topic으로
// 도배되지 않도록 diversity 제약을 적용하는 최종 selection 단계.
//
// 규칙(DIVERSITY_CONFIG, config로 조절 가능):
// 1) 동일 seedQuery는 최대 maxPerSeedQuery개까지만.
// 2) 동일 canonical keyword(topic)는 최대 maxPerCanonicalTopic개까지만.
// 3) enableCategoryBackfill이 true면, targetCategories 중 Top N에 대표가 없는 category를
//    candidate pool에서 찾아 채운다 — 단, 그 category에 해당하는 candidate가 pool에 아예 없으면
//    억지로 채우지 않는다(실제 고점 이슈가 없는 category를 낮은 점수로 강제 편입하지 않기 위함).

import { DIVERSITY_CONFIG } from "../../config/keywordScoring.js";

export type DiversityCandidate = {
  keyword: string;
  seedQuery: string | null;
  category: string;
  totalScore: number;
};

export function selectDiverseTopN<T extends DiversityCandidate>(sortedByScoreDesc: T[], topN: number): T[] {
  const seedQueryCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const selected: T[] = [];
  const selectedSet = new Set<T>();

  const canSelect = (item: T): boolean => {
    if (item.seedQuery && (seedQueryCounts.get(item.seedQuery) ?? 0) >= DIVERSITY_CONFIG.maxPerSeedQuery) {
      return false;
    }
    if ((topicCounts.get(item.keyword) ?? 0) >= DIVERSITY_CONFIG.maxPerCanonicalTopic) {
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
    topicCounts.set(item.keyword, (topicCounts.get(item.keyword) ?? 0) + 1);
  };

  // 1) 점수 순으로 훑으며 seedQuery/topic cap을 지키는 선에서 greedy하게 채운다.
  for (const item of sortedByScoreDesc) {
    if (selected.length >= topN) break;
    if (canSelect(item)) markSelected(item);
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
      topicCounts.set(removed.keyword, Math.max(0, (topicCounts.get(removed.keyword) ?? 1) - 1));

      selected[toRemove.index] = candidate;
      selectedSet.add(candidate);
      if (candidate.seedQuery) {
        seedQueryCounts.set(candidate.seedQuery, (seedQueryCounts.get(candidate.seedQuery) ?? 0) + 1);
      }
      topicCounts.set(candidate.keyword, (topicCounts.get(candidate.keyword) ?? 0) + 1);
    }
  }

  return selected.sort((a, b) => b.totalScore - a.totalScore);
}
