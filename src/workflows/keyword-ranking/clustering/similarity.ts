// clustering에서 사용하는 순수 유사도 함수 모음. 세 신호를 독립적으로 계산할 수 있게 분리해둔다.

export function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count++;
  }
  return count;
}

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  const intersection = intersectionSize(a, b);
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** char n-gram multiset과 그 총 개수. 같은 문자열을 여러 번 비교할 때 한 번만 만들어 재사용한다. */
export type CharNgramProfile = {
  counts: Map<string, number>;
  total: number;
};

export function buildCharNgramProfile(text: string, n: number): CharNgramProfile {
  const compact = text.replace(/\s+/g, "");
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i <= compact.length - n; i++) {
    const gram = compact.slice(i, i + n);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
    total++;
  }
  return { counts, total };
}

// charNgramSimilarity의 미리 만든 profile 버전. 계산식은 완전히 같다.
// 2026-11-25 엔터 수집 창 하루 확대로 후보가 수천 건이 되면서, clustering 루프가 같은 문자열의
// n-gram Map을 비교마다 새로 만드는 비용(O(n²)번)이 지배적이 됐다 - 결과는 바꾸지 않고 재사용만 한다.
export function charNgramSimilarityFromProfiles(a: CharNgramProfile, b: CharNgramProfile): number {
  if (a.total === 0 || b.total === 0) return 0;

  let overlap = 0;
  for (const [gram, countA] of a.counts) {
    const countB = b.counts.get(gram);
    if (countB) overlap += Math.min(countA, countB);
  }

  return (2 * overlap) / (a.total + b.total);
}

// character n-gram multiset 기반 Dice 계수.
// 형태소 분석 없이도 "중증외상센터" vs "중증"처럼 부분적으로만 겹치는 표현의 유사도를 어느 정도 잡아내기 위한 보조 신호.
export function charNgramSimilarity(a: string, b: string, n: number): number {
  return charNgramSimilarityFromProfiles(buildCharNgramProfile(a, n), buildCharNgramProfile(b, n));
}
