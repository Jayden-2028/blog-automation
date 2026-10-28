// 문장 단위 diff: 원고(before) 문장 열과 발행본(after) 문장 열을 순서 보존 정렬해
// 지운 문장 / 보탠 문장 / 고쳐 쓴 문장(유사도 0.5~0.9)으로 나눈다.
import { diceSimilarity } from "./text.js";

export const REWRITE_MIN = 0.5;
export const UNCHANGED_MIN = 0.9;

export type Rewritten = { before: string; after: string; similarity: number };
export type SentenceDiff = { removed: string[]; added: string[]; rewritten: Rewritten[]; unchanged: number };

const round2 = (x: number) => Math.round(x * 100) / 100;

/** 순서를 보존하는 최대 유사도 정렬(가중 LCS). 유사도 < REWRITE_MIN인 쌍은 정렬하지 않는다. */
export function diffSentences(before: string[], after: string[]): SentenceDiff {
  const n = before.length;
  const m = after.length;
  const sim: number[][] = before.map((b) => after.map((a) => diceSimilarity(b, a)));
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const s = sim[i - 1]![j - 1]!;
      const take = s >= REWRITE_MIN ? dp[i - 1]![j - 1]! + s : -1;
      dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!, take);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = sim[i - 1]![j - 1]!;
    if (s >= REWRITE_MIN && dp[i]![j] === dp[i - 1]![j - 1]! + s) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i -= 1;
    else j -= 1;
  }
  pairs.reverse();

  const usedB = new Set(pairs.map(([b]) => b));
  const usedA = new Set(pairs.map(([, a]) => a));
  const rewritten: Rewritten[] = [];
  let unchanged = 0;
  const record = (b: number, a: number) => {
    const s = sim[b]![a]!;
    if (s >= UNCHANGED_MIN) unchanged += 1;
    else rewritten.push({ before: before[b]!, after: after[a]!, similarity: round2(s) });
  };
  for (const [b, a] of pairs) record(b, a);

  // 정렬 밖에 남은 문장 중 순서가 바뀐(이동한) 고쳐쓰기를 한 번 더 줍는다.
  for (let b = 0; b < n; b += 1) {
    if (usedB.has(b)) continue;
    let bestA = -1;
    let bestS = 0;
    for (let a = 0; a < m; a += 1) {
      if (usedA.has(a)) continue;
      const s = sim[b]![a]!;
      if (s > bestS) {
        bestS = s;
        bestA = a;
      }
    }
    if (bestA >= 0 && bestS >= REWRITE_MIN) {
      usedB.add(b);
      usedA.add(bestA);
      record(b, bestA);
    }
  }
  return {
    removed: before.filter((_, idx) => !usedB.has(idx)),
    added: after.filter((_, idx) => !usedA.has(idx)),
    rewritten,
    unchanged,
  };
}
