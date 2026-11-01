// trend_candidates에 upsert하기 직전, 제외 대상 카테고리·스포츠 키워드를 걸러낸다(2026-09-07).
// Creator Advisor/Google Trends/Community 세 수집 경로가 모두 이 함수를 거친다 - "육아 카테고리는
// 수집 단계에서 원천 차단한다"는 결정이 한 곳에서만 구현되도록 하기 위함(각 소스 매퍼에 따로
// 심으면 나중에 규칙을 바꿀 때 세 곳을 다 고쳐야 한다).
//
// **2026-11-01: 정치는 여기서 거르지 않는다.** `trend_candidates`는 엔터·사회 두 트랙이 같이 쓰는
// 저장소다. 여기서 정치를 버리면 나중에 사회 트랙이 읽을 때 이미 없다. 그래서 저장은 다 하고
// **트랙별 판정은 읽는 쪽**(`dailyKeywordWorkflow`의 `allowPolitics`)에서 한다.
// 엔터 트랙이 정치를 집어 갈 위험은 두 겹으로 막힌다 - ① `includeCategories: ["entertainment","ott"]`로
// 정치 키워드(living/incident로 분류된다)가 pool에서 빠지고, ② 그래도 남으면 `allowPolitics=false`인
// 쪽에서 `shouldExcludeCandidate`가 거른다.

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
    // allowPolitics: true - 저장소는 정치를 품는다(위 머리말). 육아·스포츠는 그대로 버린다.
    if (shouldExcludeCandidate(row.keyword, row.topic_normalized, null, { allowPolitics: true })) {
      excludedCount += 1;
      continue;
    }
    kept.push(row);
  }

  return { rows: kept, excludedCount };
}
