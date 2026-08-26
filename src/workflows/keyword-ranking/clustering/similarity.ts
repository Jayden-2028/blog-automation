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

function toCharNgramCounts(text: string, n: number): Map<string, number> {
  const compact = text.replace(/\s+/g, "");
  const counts = new Map<string, number>();
  for (let i = 0; i <= compact.length - n; i++) {
    const gram = compact.slice(i, i + n);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

// character n-gram multiset 기반 Dice 계수.
// 형태소 분석 없이도 "중증외상센터" vs "중증"처럼 부분적으로만 겹치는 표현의 유사도를 어느 정도 잡아내기 위한 보조 신호.
export function charNgramSimilarity(a: string, b: string, n: number): number {
  const gramsA = toCharNgramCounts(a, n);
  const gramsB = toCharNgramCounts(b, n);

  let totalA = 0;
  for (const count of gramsA.values()) totalA += count;
  let totalB = 0;
  for (const count of gramsB.values()) totalB += count;

  if (totalA === 0 || totalB === 0) return 0;

  let overlap = 0;
  for (const [gram, countA] of gramsA) {
    const countB = gramsB.get(gram);
    if (countB) overlap += Math.min(countA, countB);
  }

  return (2 * overlap) / (totalA + totalB);
}
