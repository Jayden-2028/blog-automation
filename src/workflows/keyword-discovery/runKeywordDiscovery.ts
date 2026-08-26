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
  /** true면 후보 생성까지만 수행하고 Supabase 조회/저장을 건너뛰었다. */
  persistenceSkipped: boolean;
};

export type RunKeywordDiscoveryOptions = {
  /** 기본 true. 테스트/미리보기에서는 false로 두어 Supabase에 쓰지 않는다. */
  persistCandidates?: boolean;
};

export async function runKeywordDiscovery(
  provider: KeywordProvider,
  options: RunKeywordDiscoveryOptions = {}
): Promise<KeywordDiscoverySummary> {
  const rawKeywords = await provider.fetchKeywords();
  const normalizedKeywords = normalizeKeywords(rawKeywords);
  const { candidates, duplicateCount } = deduplicateKeywords(normalizedKeywords);

  const persistCandidates = options.persistCandidates ?? true;
  const { existingInDb, inserted, insertedKeywords } = persistCandidates
    ? await saveKeywordCandidates(candidates)
    : { existingInDb: 0, inserted: 0, insertedKeywords: [] };

  return {
    fetched: rawKeywords.length,
    normalized: normalizedKeywords.length,
    duplicateInBatch: duplicateCount,
    existingInDb,
    inserted,
    insertedKeywords,
    persistenceSkipped: !persistCandidates,
  };
}
