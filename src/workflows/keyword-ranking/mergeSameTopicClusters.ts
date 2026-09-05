// clustering 결과에 대한 2차 병합 pass: "서로 다른 cluster지만 사실은 같은 이슈"를 합친다.
//
// 왜 필요한가(2026-09-04 실측, run #34):
// 부산 오피스텔 추락사 한 사건이 Top 10에 두 칸을 차지했다.
//   #?  76점 ott       "가해자 누나는 KBS 드라마 출연 중" 부산 오피스텔 추락사 사건 전말
//   #10 37점 community "내 딸은 죽었는데..." 부산 오피스텔 추락사 유족, KBS에 청원
// 실제 pairwise 유사도를 재보니 combined=0.270이었다. cross-seed 임계값(0.55)은 물론이고
// **seed가 같았다고 가정해도 0.284로 같은-seed 임계값(0.38)조차 못 넘는다.** 즉 이 실패는
// seed 제외 규칙만의 문제가 아니라, 뉴스 제목에 수식어가 많아 Jaccard가 구조적으로 낮게 나오는
// 문제다(topicGrouping.ts 상단 주석 §2에 실측 0.169~0.238로 기록된 그것).
//
// clustering 임계값을 낮추는 것으로는 못 고친다. 0.27을 병합하려면 threshold를 0.25까지 내려야
// 하는데, 그러면 무관한 후보들이 대량으로 오병합된다(임계값 0.38은 그 균형점으로 정해진 값이다).
//
// 그래서 clustering 자체는 건드리지 않고(오병합 위험이 가장 큰 영역), 그 결과 위에서 한 번 더
// "같은 주제인가"만 본다. 판정은 topicGrouping.isSameTopic()을 그대로 쓴다 - 이미 Top N 중복
// 방지용으로 검증된 로직이고(test:topic-grouping), 희소 핵심 명사 공유/핵심 명사 overlap이라는
// 다른 축의 신호라서 Jaccard가 낮아도 같은 이슈를 잡아낸다. 위 사례로 실측 확인했다:
//   isSameTopic = true, 무관한 쌍(추락사 vs 이마트/불꽃축제)은 false 유지.
//
// selectDiverseTopN과의 역할 차이: 그쪽은 "이미 뽑은 것과 같은 주제면 Top N에서 뺀다"이고,
// 이쪽은 "애초에 하나로 합쳐서 신호를 합산한다"이다. 쪼개진 채로 두면 relatedCount/newsCount/
// crossSource가 각각 나뉘어 실제보다 낮게 채점되므로, 정말 화제인 이슈가 순위에서 손해를 본다.
//
// ⚠️ 이 병합을 실제로 적용하는 것은 clustering 로직 변경이라 사용자 승인이 필요하다
// (CLAUDE.md "승인 없이는 금지"). 기본값은 미적용(preview만)이다.

import { TOPIC_MERGE_CONFIG } from "../../config/keywordCompetition.js";
import { buildTopicIndex } from "./topicGrouping.js";
import type { KeywordCluster } from "./clustering/KeywordClusterer.js";

export type MergeSameTopicClustersOptions = {
  /**
   * 이번 run에서 "분류어"로 취급할 단어(seed_queries 유래 상시 검색어).
   * topicGrouping의 extraCategoryTerms로 그대로 전달된다.
   */
  categoryTerms?: readonly string[];
};

export type MergedTopicGroup = {
  /** 합쳐진 뒤의 대표 키워드. */
  representativeKeyword: string;
  /** 흡수된 cluster들의 대표 키워드(대표 자신 포함, 입력 순서). */
  memberKeywords: string[];
  /** 합쳐진 뒤의 항목 수. */
  mergedItemCount: number;
};

export type MergeSameTopicClustersResult<T> = {
  clusters: KeywordCluster<T>[];
  /** 실제로 2개 이상이 합쳐진 그룹만. 아무것도 안 합쳐졌으면 빈 배열. */
  mergedGroups: MergedTopicGroup[];
};

/**
 * 같은 주제로 판정된 cluster들을 합친다. 원본 배열을 수정하지 않는다.
 *
 * 병합 전략은 "대표 기준 greedy"다. 큰 cluster부터 시드로 삼고, 나머지를 **시드와만** 비교해
 * 붙인다. 연쇄 비교(A~B, B~C 이므로 A~C)를 하지 않는 이유는 isSameTopic이 이행적이지 않아
 * 주제가 조금씩 흘러가며 무관한 것까지 한 덩어리가 될 수 있기 때문이다.
 */
export function mergeSameTopicClusters<T extends { keyword: string }>(
  clusters: readonly KeywordCluster<T>[],
  options: MergeSameTopicClustersOptions = {}
): MergeSameTopicClustersResult<T> {
  if (clusters.length < 2) {
    return { clusters: [...clusters], mergedGroups: [] };
  }

  // df 기반 희소성 판정이 의미를 가지려면 batch 전체를 봐야 한다(topicGrouping.ts).
  const topicIndex = buildTopicIndex(clusters, (cluster) => cluster.representativeKeyword, {
    extraCategoryTerms: options.categoryTerms,
  });

  // 큰 cluster가 시드가 되도록 정렬하되, 원래 순서를 tiebreak으로 유지해 결과를 결정적으로 만든다.
  const order = clusters
    .map((cluster, index) => ({ cluster, index }))
    .sort((a, b) => b.cluster.items.length - a.cluster.items.length || a.index - b.index);

  const consumed = new Set<number>();
  const merged: { cluster: KeywordCluster<T>; index: number; members: string[] }[] = [];

  for (const { cluster: seed, index: seedIndex } of order) {
    if (consumed.has(seedIndex)) continue;
    consumed.add(seedIndex);

    const items = [...seed.items];
    const members = [seed.representativeKeyword];

    for (const { cluster: other, index: otherIndex } of order) {
      if (consumed.has(otherIndex)) continue;
      if (!topicIndex.isSameTopic(seed, other)) continue;

      consumed.add(otherIndex);
      items.push(...other.items);
      members.push(other.representativeKeyword);
    }

    merged.push({
      // 대표는 가장 짧은 키워드를 쓴다 - CompositeSimilarityClusterer.pickRepresentative와 같은 규칙.
      cluster: {
        representativeKeyword: members.reduce((shortest, keyword) =>
          keyword.length < shortest.length ? keyword : shortest
        ),
        items,
      },
      index: seedIndex,
      members,
    });
  }

  // 입력 순서를 복원한다. 다운스트림(aggregateClusterSignals 등)은 순서에 의존하지 않지만,
  // 로그/디버그에서 결과를 비교하기 쉬우려면 안정적인 순서가 낫다.
  merged.sort((a, b) => a.index - b.index);

  const mergedGroups: MergedTopicGroup[] = merged
    .filter((entry) => entry.members.length > 1)
    .map((entry) => ({
      representativeKeyword: entry.cluster.representativeKeyword,
      memberKeywords: entry.members,
      mergedItemCount: entry.cluster.items.length,
    }));

  return { clusters: merged.map((entry) => entry.cluster), mergedGroups };
}

/** 설정이 적용(apply)을 허용하는지. preview만 하는 기본 상태에서는 false. */
export function isTopicMergeEnabled(): boolean {
  return TOPIC_MERGE_CONFIG.applyToClusters;
}
