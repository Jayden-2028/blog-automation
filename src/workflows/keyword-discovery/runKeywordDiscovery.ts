import type { KeywordProvider } from "../../services/search/providers/KeywordProvider.js";
import type { KeywordRow } from "../../types/database.js";
import { deduplicateKeywords } from "./deduplicateKeywords.js";
import { normalizeKeywords } from "./normalizeKeywords.js";
import { saveKeywordCandidates } from "./saveKeywordCandidates.js";

export type KeywordDiscoverySummary = {
  fetched: number;
  normalized: number;
  duplicateInBatch: number;
  existingInDb: number;
  inserted: number;
  insertedKeywords: KeywordRow[];
};

export async function runKeywordDiscovery(
  provider: KeywordProvider
): Promise<KeywordDiscoverySummary> {
  const rawKeywords = await provider.fetchKeywords();
  const normalizedKeywords = normalizeKeywords(rawKeywords);
  const { candidates, duplicateCount } = deduplicateKeywords(normalizedKeywords);

  const { existingInDb, inserted, insertedKeywords } = await saveKeywordCandidates(
    candidates
  );

  return {
    fetched: rawKeywords.length,
    normalized: normalizedKeywords.length,
    duplicateInBatch: duplicateCount,
    existingInDb,
    inserted,
    insertedKeywords,
  };
}
