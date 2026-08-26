// Creator Advisor parser 결과(CreatorAdvisorTrendCandidate)를 trend_candidates DB row 형태
// (TrendCandidateInsert)로 변환하는 순수 함수. DB 접근(TrendCandidateRepository)과는 분리되어 있다 -
// repository는 이미 만들어진 TrendCandidateInsert[]를 upsert하기만 한다.
//
// topic은 원문 그대로 topic에 보존하고(요구사항: "원본 topic은 반드시 별도 보존"),
// topic_normalized에만 내부 category mapping(creatorAdvisorTopicMapping.ts)을 적용한다.

import { CREATOR_ADVISOR_CONFIG } from "../../config/creatorAdvisor.js";
import { mapCreatorAdvisorTopicToCategory } from "../../config/creatorAdvisorTopicMapping.js";
import { classifyKeywordCategory } from "../../config/keywordCategoryRules.js";
import { computeCreatorAdvisorCandidateScore } from "./scoreCreatorAdvisorCandidate.js";
import type { CreatorAdvisorTrendCandidate } from "../../services/search/providers/CreatorAdvisorProvider.js";
import type { TrendCandidateInsert } from "../../types/database.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 내부 category를 정한다. Creator Advisor는 category를 topic card 단위로만 주기 때문에 카드 하나에
 * 성격이 다른 키워드가 섞인다(실측: "육아·결혼" 카드 20건 중 진짜 육아는 7건뿐이고 나머지는
 * 정부 지원금과 연예 뉴스였다). 그래서 키워드 어휘로 먼저 판정하고, 확실한 신호가 없을 때만
 * topic 매핑으로 폴백한다.
 */
export function resolveCreatorAdvisorCategory(keyword: string, topic: string): string {
  return classifyKeywordCategory(keyword) ?? mapCreatorAdvisorTopicToCategory(topic);
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
    topic_normalized: resolveCreatorAdvisorCategory(candidate.keyword, candidate.topic),
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

// ---------- upsert 전 dedupe ----------
//
// 왜 필요한가(2026-08-26 실측): trend_candidates의 unique index는
// (keyword_normalized, topic_normalized, trend_date, source)인데, topic_normalized는 원본 topic이
// 아니라 mapCreatorAdvisorTopicToCategory()로 매핑한 "내부 카테고리"다. 실제 계정의 Creator Advisor
// topic 11개는 카테고리 4개로 축소된다(living 하나에만 6개 topic이 모인다). 그래서 같은 키워드가 같은
// 카테고리에 속한 서로 다른 topic 두 곳에 등장하면(예: "구글 타임라인"이 세계여행과 IT·컴퓨터에 동시
// 등장) 한 번의 upsert 배치 안에 conflict key가 같은 행이 2개 생기고, PostgreSQL이
// "ON CONFLICT DO UPDATE command cannot affect row a second time"(21000)으로 배치 전체를 거부한다.
//
// 그래서 DB에 보내기 전에 conflict key 기준으로 병합한다. 승자는 candidate_score가 높은 쪽이며
// (동점이면 rank가 앞선 쪽), 버려지는 쪽의 원본 topic/rank는 metadata.mergedFrom에 남겨 "어느 topic에
// 나왔는지"라는 신호를 잃지 않는다(buildDailyQueryPool의 merge와 같은 원칙).

export type DedupeTrendCandidateInsertsResult = {
  rows: TrendCandidateInsert[];
  /** 병합되어 사라진 행 수. */
  droppedCount: number;
};

function conflictKey(row: TrendCandidateInsert): string {
  const source = row.source ?? "creator_advisor";
  return [row.keyword_normalized, row.topic_normalized, row.trend_date, source].join("|");
}

/** 같은 conflict key를 가진 행을 하나로 병합한다. 입력 순서는 보존한다. */
export function dedupeTrendCandidateInserts(
  rows: TrendCandidateInsert[]
): DedupeTrendCandidateInsertsResult {
  const byKey = new Map<string, TrendCandidateInsert>();

  for (const row of rows) {
    const key = conflictKey(row);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, row);
      continue;
    }

    const existingScore = existing.candidate_score ?? 0;
    const nextScore = row.candidate_score ?? 0;
    const rowWins = nextScore > existingScore || (nextScore === existingScore && row.rank < existing.rank);
    const winner = rowWins ? row : existing;
    const loser = rowWins ? existing : row;

    const mergedFrom = Array.isArray(winner.metadata?.mergedFrom)
      ? (winner.metadata.mergedFrom as unknown[])
      : [];

    byKey.set(key, {
      ...winner,
      metadata: {
        ...winner.metadata,
        mergedFrom: [
          ...mergedFrom,
          { topic: loser.topic, rank: loser.rank, candidateScore: loser.candidate_score },
        ],
      },
    });
  }

  return { rows: [...byKey.values()], droppedCount: rows.length - byKey.size };
}
