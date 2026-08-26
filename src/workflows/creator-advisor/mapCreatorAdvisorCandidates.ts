// Creator Advisor parser 결과(CreatorAdvisorTrendCandidate)를 trend_candidates DB row 형태
// (TrendCandidateInsert)로 변환하는 순수 함수. DB 접근(TrendCandidateRepository)과는 분리되어 있다 -
// repository는 이미 만들어진 TrendCandidateInsert[]를 upsert하기만 한다.
//
// topic은 원문 그대로 topic에 보존하고(요구사항: "원본 topic은 반드시 별도 보존"),
// topic_normalized에만 내부 category mapping(creatorAdvisorTopicMapping.ts)을 적용한다.

import { CREATOR_ADVISOR_CONFIG } from "../../config/creatorAdvisor.js";
import { mapCreatorAdvisorTopicToCategory } from "../../config/creatorAdvisorTopicMapping.js";
import { computeCreatorAdvisorCandidateScore } from "./scoreCreatorAdvisorCandidate.js";
import type { CreatorAdvisorTrendCandidate } from "../../services/search/providers/CreatorAdvisorProvider.js";
import type { TrendCandidateInsert } from "../../types/database.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export type MapCreatorAdvisorCandidateOptions = {
  /** expires_at = collectedAt + ttlHours. 생략하면 CREATOR_ADVISOR_CONFIG.candidateTtlHours. */
  ttlHours?: number;
};

/**
 * candidate.metadata.trendDate(파서가 채워둔 값)를 trend_date로 쓴다 - 없으면(이론상 발생하면 안
 * 되지만 방어적으로) collectedAt의 날짜 부분으로 대체한다.
 */
function resolveTrendDate(candidate: CreatorAdvisorTrendCandidate): string {
  const metadataTrendDate = candidate.metadata.trendDate;
  if (typeof metadataTrendDate === "string" && metadataTrendDate) {
    return metadataTrendDate;
  }
  return candidate.collectedAt.slice(0, 10);
}

/** CreatorAdvisorTrendCandidate 1개 -> trend_candidates insert row 1개. candidate_score도 함께 계산한다. */
export function mapCreatorAdvisorCandidateToInsert(
  candidate: CreatorAdvisorTrendCandidate,
  options: MapCreatorAdvisorCandidateOptions = {}
): TrendCandidateInsert {
  const ttlHours = options.ttlHours ?? CREATOR_ADVISOR_CONFIG.candidateTtlHours;
  const expiresAt = new Date(new Date(candidate.collectedAt).getTime() + ttlHours * 60 * 60 * 1000).toISOString();

  return {
    keyword: candidate.keyword,
    keyword_normalized: normalize(candidate.keyword),
    topic: candidate.topic,
    topic_normalized: mapCreatorAdvisorTopicToCategory(candidate.topic),
    source: "creator_advisor",
    trend_date: resolveTrendDate(candidate),
    rank: candidate.rank,
    movement_type: candidate.movementType,
    rank_change: candidate.rankChange,
    candidate_score: computeCreatorAdvisorCandidateScore(candidate),
    collected_at: candidate.collectedAt,
    expires_at: expiresAt,
    status: "active",
    metadata: candidate.metadata,
  };
}

export function mapCreatorAdvisorCandidatesToInserts(
  candidates: CreatorAdvisorTrendCandidate[],
  options: MapCreatorAdvisorCandidateOptions = {}
): TrendCandidateInsert[] {
  return candidates.map((candidate) => mapCreatorAdvisorCandidateToInsert(candidate, options));
}
