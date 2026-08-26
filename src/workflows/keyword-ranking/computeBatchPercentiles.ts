// batch(이번 run에서 나온 전체 cluster) 내 상대적 위치를 percentile(0~1)로 계산해 채워 넣는다.
// 절대 건수만으로는 소량 테스트처럼 표본이 작을 때 변별력이 거의 없어(예: 1건 vs 0건),
// "이 batch 안에서는 상위권"이라는 상대 신호를 News Velocity / Content Demand 점수에 함께 반영하기 위함.

import type { KeywordScoreInput } from "../../types/keywordScoring.js";

// value보다 작거나 같은 값의 비율. 값이 하나뿐인 batch는 비교 대상이 없으므로 최댓값(1)으로 처리한다.
function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) return 1;
  const lowerOrEqualCount = values.filter((candidate) => candidate <= value).length;
  return lowerOrEqualCount / values.length;
}

export function computeBatchPercentiles(inputs: KeywordScoreInput[]): KeywordScoreInput[] {
  const newsCounts = inputs.map((input) => input.newsCount);
  const contentCounts = inputs.map((input) => input.blogCount + input.webCount);

  return inputs.map((input) => ({
    ...input,
    newsCountPercentile: percentileRank(newsCounts, input.newsCount),
    contentCountPercentile: percentileRank(contentCounts, input.blogCount + input.webCount),
  }));
}
