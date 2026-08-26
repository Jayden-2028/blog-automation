import {
  createKeyword,
  findRecentKeywordByName,
} from "../../services/supabase/repositories/keywordRepository.js";
import type { KeywordRow } from "../../types/database.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

// 같은 keyword가 이 시간(시간 단위) 내에 이미 저장되어 있으면 새로 만들지 않고 skip한다.
const DUPLICATE_WINDOW_HOURS = 24;

export type SaveKeywordCandidatesResult = {
  existingInDb: number;
  inserted: number;
  insertedKeywords: KeywordRow[];
};

// keyword discovery의 DB 저장 단계. runKeywordDiscovery / runNaverKeywordDiscovery가 공통으로 사용한다.
export async function saveKeywordCandidates(
  candidates: KeywordCandidate[]
): Promise<SaveKeywordCandidatesResult> {
  const sinceIso = new Date(
    Date.now() - DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();

  let existingInDb = 0;
  const insertedKeywords: KeywordRow[] = [];

  for (const candidate of candidates) {
    const existing = await findRecentKeywordByName(candidate.keyword, sinceIso);
    if (existing) {
      existingInDb++;
      continue;
    }

    const created = await createKeyword({
      keyword: candidate.keyword,
      category: candidate.category,
      source: candidate.source,
      trend_score: candidate.trendScore,
    });
    insertedKeywords.push(created);
  }

  return {
    existingInDb,
    inserted: insertedKeywords.length,
    insertedKeywords,
  };
}
