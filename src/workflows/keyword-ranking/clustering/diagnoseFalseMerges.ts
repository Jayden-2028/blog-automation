// clustering 결과에서 "서로 다른 seedQuery가 여러 개 섞인 cluster"를 진단용으로 뽑아 보여준다.
// 실제 merge 여부를 바꾸지 않는 순수 read-only 진단 도구 — dailyKeywordDryRun.ts 등에서
// false merge가 남아있는지 확인할 때 사용한다.
//
// 각 진단 항목은 cluster 안에서 서로 다른 seedQuery를 가진 대표 candidate 쌍 중 합성 유사도가
// 가장 높은("가장 병합을 정당화하기 쉬웠던") pair를 골라 token overlap / entity overlap /
// char n-gram 유사도를 분해해서 보여준다 — pairwiseSimilarity()가 실제 clustering 루프
// (CompositeSimilarityClusterer)와 동일한 계산/신뢰 로직을 쓰므로 진단 결과가 실제 동작과 일치한다.

import { pairwiseSimilarity } from "./CompositeSimilarityClusterer.js";
import type { KeywordCluster } from "./KeywordClusterer.js";
import type { KeywordCandidate } from "../../../types/keywordDiscovery.js";

export type FalseMergePairDiagnostic = {
  seedA: string;
  seedB: string;
  titleA: string;
  titleB: string;
  tokenOverlap: number;
  entityOverlap: number;
  charSimilarity: number;
  combined: number;
};

export type FalseMergeDiagnostic = {
  clusterKeyword: string;
  clusterSize: number;
  seedQueries: string[];
  representativeNormalizedTitles: string[];
  /** 서로 다른 seed를 가진 대표 candidate 쌍 중 합성 유사도가 가장 높은 pair(merge 근거로 가장 유력한 pair). */
  worstPair: FalseMergePairDiagnostic | null;
  /** seedQueries.length가 warningSeedCountThreshold 이상이면 "warning", 2개 이상이면 "info". */
  severity: "warning" | "info";
};

function extractSeedQuery(item: KeywordCandidate): string | undefined {
  const value = item.metadata.query;
  return typeof value === "string" && value ? value : undefined;
}

// cluster 안에서 seedQuery별 대표 candidate(첫 등장) 1건만 남긴다 — 진단용 pairwise 비교 대상을
// seed 개수만큼으로 줄여 O(n^2) 비교가 과도해지지 않게 한다.
function representativeBySeed(items: KeywordCandidate[]): Map<string, KeywordCandidate> {
  const bySeed = new Map<string, KeywordCandidate>();
  for (const item of items) {
    const seedQuery = extractSeedQuery(item);
    if (!seedQuery) continue;
    if (!bySeed.has(seedQuery)) bySeed.set(seedQuery, item);
  }
  return bySeed;
}

export function diagnoseClusters(
  clusters: KeywordCluster<KeywordCandidate>[],
  warningSeedCountThreshold = 5
): FalseMergeDiagnostic[] {
  const diagnostics: FalseMergeDiagnostic[] = [];

  for (const cluster of clusters) {
    const bySeed = representativeBySeed(cluster.items);
    if (bySeed.size < 2) continue; // 단일 seed cluster는 false-merge 진단 대상이 아니다.

    const seedQueries = [...bySeed.keys()];
    const representatives = [...bySeed.values()];

    let worstPair: FalseMergePairDiagnostic | null = null;
    let bestCombined = -1;

    for (let i = 0; i < representatives.length; i++) {
      for (let j = i + 1; j < representatives.length; j++) {
        const result = pairwiseSimilarity(representatives[i], representatives[j]);
        if (result.combined > bestCombined) {
          bestCombined = result.combined;
          worstPair = {
            seedA: seedQueries[i],
            seedB: seedQueries[j],
            titleA: representatives[i].keyword,
            titleB: representatives[j].keyword,
            tokenOverlap: Number(result.tokenScore.toFixed(3)),
            entityOverlap: result.coreNounIntersection,
            charSimilarity: Number(result.charNgramScore.toFixed(3)),
            combined: Number(result.combined.toFixed(3)),
          };
        }
      }
    }

    diagnostics.push({
      clusterKeyword: cluster.representativeKeyword,
      clusterSize: cluster.items.length,
      seedQueries,
      representativeNormalizedTitles: representatives.map((item) => item.keyword),
      worstPair,
      severity: seedQueries.length >= warningSeedCountThreshold ? "warning" : "info",
    });
  }

  return diagnostics;
}
