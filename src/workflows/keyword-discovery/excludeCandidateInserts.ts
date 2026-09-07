// trend_candidates에 upsert하기 직전, 제외 대상 카테고리·정치 키워드를 걸러낸다(2026-09-07).
// Creator Advisor/Google Trends/Community 세 수집 경로가 모두 이 함수를 거친다 - "육아 카테고리는
// 수집 단계에서 원천 차단한다"는 결정이 한 곳에서만 구현되도록 하기 위함(각 소스 매퍼에 따로
// 심으면 나중에 규칙을 바꿀 때 세 곳을 다 고쳐야 한다).

import { shouldExcludeCandidate } from "../../config/keywordExclusionRules.js";
import type { TrendCandidateInsert } from "../../types/database.js";

export type ExcludeCandidateInsertsResult = {
  rows: TrendCandidateInsert[];
  excludedCount: number;
};

export function excludeCandidateInserts(rows: TrendCandidateInsert[]): ExcludeCandidateInsertsResult {
  const kept: TrendCandidateInsert[] = [];
  let excludedCount = 0;

  for (const row of rows) {
    if (shouldExcludeCandidate(row.keyword, row.topic_normalized)) {
      excludedCount += 1;
      continue;
    }
    kept.push(row);
  }

  return { rows: kept, excludedCount };
}
