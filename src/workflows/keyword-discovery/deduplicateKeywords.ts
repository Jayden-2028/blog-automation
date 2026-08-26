import type {
  KeywordCandidate,
  NormalizedKeyword,
} from "../../types/keywordDiscovery.js";

export type DeduplicateKeywordsResult = {
  candidates: KeywordCandidate[];
  duplicateCount: number;
};

// 같은 실행(batch) 내에서 normalizedKey(대소문자/공백 무시)가 같은 키워드를 제거한다.
// 먼저 등장한 항목을 우선하여 유지한다.
export function deduplicateKeywords(
  normalizedKeywords: NormalizedKeyword[]
): DeduplicateKeywordsResult {
  const seen = new Map<string, NormalizedKeyword>();
  let duplicateCount = 0;

  for (const item of normalizedKeywords) {
    if (seen.has(item.normalizedKey)) {
      duplicateCount++;
      continue;
    }
    seen.set(item.normalizedKey, item);
  }

  const candidates: KeywordCandidate[] = Array.from(seen.values()).map(
    ({ normalizedKey, ...candidate }) => candidate
  );

  return { candidates, duplicateCount };
}
