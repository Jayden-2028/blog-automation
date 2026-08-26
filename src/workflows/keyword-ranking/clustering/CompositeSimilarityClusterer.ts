// 세 가지 유사도 신호(token overlap / 핵심 명사 overlap / character n-gram)를 합성해 판단하는 clustering 구현.
// 단순 token Jaccard 하나만으로는 실제 뉴스/블로그 title처럼 수식어가 많이 붙은 긴 문장에서
// 핵심 이슈가 같아도 거의 병합되지 않는 문제가 있어(다른 수식어 토큰들이 분모를 키움), 세 신호를 가중 합산한다.
// - token overlap: 조사/seed 제거 후 전체 토큰 집합 Jaccard. (primary 신호)
// - 핵심 명사 overlap: 숫자/서술어 토큰까지 제외한, 더 좁고 안정적인 토큰 집합 Jaccard. (primary 신호)
// - character n-gram: 형태소가 달라도(예: "중증외상센터" vs "중증") 부분 문자열이 겹치면 반영되는 보조 신호.
//   단, token/entity 신호가 전혀 없는데 char n-gram만 높은 경우(예: "위키백과 한국어"처럼 서로 무관한
//   title이 공유하는 site boilerplate)는 그 기여를 무시한다 — isCharNgramTrusted() 참고.
//
// 또한 cross-seed merge(서로 다른 seedQuery에서 나온 candidate를 하나로 합치는 것)는 같은 seed 내부
// merge보다 강한 조건을 요구한다: 더 높은 합성 유사도 threshold + (핵심 명사 교집합 존재 또는 충분한
// token overlap). 단순 boilerplate 공통점만으로 서로 무관한 이슈가 섞이는 것을 막기 위함.
//
// 여전히 embedding/LLM은 쓰지 않는 규칙 기반 근사치이며, KeywordClusterer 인터페이스만 만족하므로
// 이후 embedding 기반 구현으로 손쉽게 교체할 수 있다.

import { CLUSTERING_CONFIG } from "../../../config/keywordScoring.js";
import { charNgramSimilarity, intersectionSize, jaccardSimilarity } from "./similarity.js";
import { extractCoreNouns, normalizedFullText, stripClusteringBoilerplate, tokenize } from "./textNormalize.js";
import type { KeywordCluster, KeywordClusterer } from "./KeywordClusterer.js";

type PreparedItem<T> = {
  item: T;
  seedQuery: string | undefined;
  tokens: Set<string>;
  coreNouns: Set<string>;
  fullText: string;
};

type MutableCluster<T> = {
  tokens: Set<string>;
  coreNouns: Set<string>;
  fullTexts: string[];
  items: T[];
  seedQueries: Set<string>;
};

function prepare<T extends { keyword: string; metadata?: Record<string, unknown> }>(
  item: T
): PreparedItem<T> {
  const seedQuery = typeof item.metadata?.query === "string" ? item.metadata.query : undefined;
  // 원문 headline(item.keyword)은 그대로 두고, clustering 유사도 계산에 넘길 텍스트에서만
  // site/source boilerplate를 제거한다.
  const clusteringText = stripClusteringBoilerplate(item.keyword);
  const tokens = tokenize(clusteringText, { seedQuery });

  return {
    item,
    seedQuery,
    tokens: new Set(tokens),
    coreNouns: new Set(extractCoreNouns(tokens)),
    fullText: normalizedFullText(clusteringText),
  };
}

// token overlap이 충분하거나(minTokenOverlapToTrustCharNgram 이상) 핵심 명사가 하나라도 겹칠 때만
// char n-gram 신호를 신뢰한다. 둘 다 없는데 char n-gram만 높다면(예: 공통 site suffix) 우연/boilerplate
// 일치일 가능성이 높으므로 merge 근거로 인정하지 않는다.
function isCharNgramTrusted(tokenScore: number, coreNounIntersection: number): boolean {
  return tokenScore >= CLUSTERING_CONFIG.minTokenOverlapToTrustCharNgram || coreNounIntersection > 0;
}

function combineSimilarity(
  tokenScore: number,
  coreNounScore: number,
  coreNounIntersection: number,
  charNgramScore: number
): number {
  const weights = CLUSTERING_CONFIG.similarityWeights;
  const weightSum = weights.tokenOverlap + weights.coreNounOverlap + weights.charNgram;
  if (weightSum === 0) return 0;

  const trustedCharNgramScore = isCharNgramTrusted(tokenScore, coreNounIntersection) ? charNgramScore : 0;

  return (
    (tokenScore * weights.tokenOverlap +
      coreNounScore * weights.coreNounOverlap +
      trustedCharNgramScore * weights.charNgram) /
    weightSum
  );
}

type SimilarityEvaluation = {
  combined: number;
  tokenScore: number;
  coreNounScore: number;
  coreNounIntersection: number;
};

function compositeSimilarity<T>(prepared: PreparedItem<T>, cluster: MutableCluster<T>): SimilarityEvaluation {
  const tokenScore = jaccardSimilarity(prepared.tokens, cluster.tokens);
  const coreNounScore = jaccardSimilarity(prepared.coreNouns, cluster.coreNouns);
  const coreNounIntersection = intersectionSize(prepared.coreNouns, cluster.coreNouns);

  // cluster 안에서 가장 가까운 fullText 하나를 기준으로 계산해, 서로 다른 항목들이 섞여 평균이
  // 흐려지는 것을 방지한다(대표 유사도 과소평가 방지).
  let charNgramScore = 0;
  for (const fullText of cluster.fullTexts) {
    const score = charNgramSimilarity(prepared.fullText, fullText, CLUSTERING_CONFIG.charNgramSize);
    if (score > charNgramScore) charNgramScore = score;
  }

  const combined = combineSimilarity(tokenScore, coreNounScore, coreNounIntersection, charNgramScore);

  return { combined, tokenScore, coreNounScore, coreNounIntersection };
}

// 진단 도구(clustering/diagnoseFalseMerges.ts)가 임의의 두 candidate 사이 유사도를 그대로 재현해서
// 볼 수 있도록 pairwise 버전을 별도로 노출한다. 실제 clustering 루프(compositeSimilarity, 위)와 동일한
// 신호 계산/신뢰 로직(combineSimilarity)을 공유해 진단 결과가 실제 동작과 어긋나지 않게 한다.
export function pairwiseSimilarity<T extends { keyword: string; metadata?: Record<string, unknown> }>(
  a: T,
  b: T
): {
  combined: number;
  tokenScore: number;
  coreNounScore: number;
  coreNounIntersection: number;
  charNgramScore: number;
} {
  const preparedA = prepare(a);
  const preparedB = prepare(b);

  const tokenScore = jaccardSimilarity(preparedA.tokens, preparedB.tokens);
  const coreNounScore = jaccardSimilarity(preparedA.coreNouns, preparedB.coreNouns);
  const coreNounIntersection = intersectionSize(preparedA.coreNouns, preparedB.coreNouns);
  const charNgramScore = charNgramSimilarity(preparedA.fullText, preparedB.fullText, CLUSTERING_CONFIG.charNgramSize);

  const combined = combineSimilarity(tokenScore, coreNounScore, coreNounIntersection, charNgramScore);

  return { combined, tokenScore, coreNounScore, coreNounIntersection, charNgramScore };
}

function pickRepresentative<T extends { keyword: string }>(items: T[]): string {
  return items.reduce(
    (shortest, item) => (item.keyword.length < shortest.length ? item.keyword : shortest),
    items[0].keyword
  );
}

export class CompositeSimilarityClusterer implements KeywordClusterer {
  cluster<T extends { keyword: string; metadata?: Record<string, unknown> }>(
    items: T[]
  ): KeywordCluster<T>[] {
    const clusters: MutableCluster<T>[] = [];

    for (const raw of items) {
      const prepared = prepare(raw);

      let bestCluster: MutableCluster<T> | null = null;
      let bestSimilarity = -1;

      for (const cluster of clusters) {
        const { combined, tokenScore, coreNounScore, coreNounIntersection } = compositeSimilarity(
          prepared,
          cluster
        );

        const isCrossSeed =
          prepared.seedQuery !== undefined &&
          cluster.seedQueries.size > 0 &&
          !cluster.seedQueries.has(prepared.seedQuery);

        const compositeThreshold = isCrossSeed
          ? CLUSTERING_CONFIG.crossSeedSimilarityThreshold
          : CLUSTERING_CONFIG.similarityThreshold;

        // naver_news/naver_blog/naver_web은 같은 이슈라도 문체가 크게 달라 합성 유사도(combined)가
        // threshold를 못 넘는 경우가 흔하다. 핵심 명사가 충분히(coreNounOverlapMinIntersection 개 이상)
        // 겹치고 그 비율도 높으면(coreNounOverlapMergeThreshold 이상) 같은 이슈로 보고 병합한다.
        const eligibleByComposite = combined >= compositeThreshold;
        const eligibleByCoreNoun =
          coreNounScore >= CLUSTERING_CONFIG.coreNounOverlapMergeThreshold &&
          coreNounIntersection >= CLUSTERING_CONFIG.coreNounOverlapMinIntersection;

        let eligible = eligibleByComposite || eligibleByCoreNoun;

        // seed-aware merge guard: cross-seed merge는 핵심 명사 교집합이 있거나 token overlap이
        // 충분히 높아야만 허용한다. 둘 다 없다면(=site boilerplate나 우연한 일치로만 threshold를
        // 넘겼다는 뜻) 아무리 combined가 높아도 서로 다른 seed를 섞지 않는다.
        if (isCrossSeed && eligible) {
          const hasEntityOverlap = coreNounIntersection > 0;
          const hasSufficientTokenOverlap = tokenScore >= CLUSTERING_CONFIG.crossSeedMinTokenOverlap;
          if (!hasEntityOverlap && !hasSufficientTokenOverlap) {
            eligible = false;
          }
        }

        if (eligible && combined > bestSimilarity) {
          bestCluster = cluster;
          bestSimilarity = combined;
        }
      }

      if (bestCluster) {
        bestCluster.items.push(prepared.item);
        for (const token of prepared.tokens) bestCluster.tokens.add(token);
        for (const noun of prepared.coreNouns) bestCluster.coreNouns.add(noun);
        bestCluster.fullTexts.push(prepared.fullText);
        if (prepared.seedQuery) bestCluster.seedQueries.add(prepared.seedQuery);
      } else {
        clusters.push({
          tokens: new Set(prepared.tokens),
          coreNouns: new Set(prepared.coreNouns),
          fullTexts: [prepared.fullText],
          items: [prepared.item],
          seedQueries: new Set(prepared.seedQuery ? [prepared.seedQuery] : []),
        });
      }
    }

    return clusters.map((cluster) => ({
      representativeKeyword: pickRepresentative(cluster.items),
      items: cluster.items,
    }));
  }
}
