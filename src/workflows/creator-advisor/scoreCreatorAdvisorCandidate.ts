// Creator Advisor 후보 pre-score(candidate_score) 계산. config/creatorAdvisorCandidateScore.ts의
// 숫자만 참조하고, 로직 코드에는 숫자를 흩뿌리지 않는다.
//
// 이 점수는 기존 keyword_rankings의 6-factor 최종 score(scoreKeyword.ts)와 완전히 별개다 -
// scoreKeyword.ts는 이 파일을 참조하지 않고, 이 파일도 scoreKeyword.ts의 가중치/로직을 건드리지 않는다.

import { CREATOR_ADVISOR_CANDIDATE_SCORE_CONFIG } from "../../config/creatorAdvisorCandidateScore.js";
import type { CreatorAdvisorMovementType } from "../../services/search/providers/CreatorAdvisorProvider.js";

export type ScorableCreatorAdvisorCandidate = {
  rank: number;
  movementType: CreatorAdvisorMovementType;
  rankChange: number | null;
};

function scoreByRank(rank: number): number {
  const { rankScoreBands, rankScoreFallback } = CREATOR_ADVISOR_CANDIDATE_SCORE_CONFIG;
  for (const band of rankScoreBands) {
    if (rank <= band.maxRank) return band.score;
  }
  return rankScoreFallback;
}

function scoreByRankChange(rankChange: number): number {
  for (const band of CREATOR_ADVISOR_CANDIDATE_SCORE_CONFIG.rankChangeBonusBands) {
    if (rankChange >= band.minRankChange) return band.score;
  }
  return 0;
}

/**
 * Creator Advisor 후보 pre-score = rank 구간 점수 + movementType 보너스 + (up이면) rankChange 크기
 * 보너스. NAVER API 검증 대상 상위 후보를 고르는 용도로만 쓰인다 - 최종 trend_score를 수정하지 않는다.
 */
export function computeCreatorAdvisorCandidateScore(candidate: ScorableCreatorAdvisorCandidate): number {
  const { movementBonus } = CREATOR_ADVISOR_CANDIDATE_SCORE_CONFIG;

  let score = scoreByRank(candidate.rank);
  score += movementBonus[candidate.movementType];

  if (candidate.movementType === "up" && candidate.rankChange !== null && candidate.rankChange > 0) {
    score += scoreByRankChange(candidate.rankChange);
  }

  return score;
}
