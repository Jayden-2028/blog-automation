// ranking 실행 이력을 discovery_runs / keyword_rankings 테이블에 저장한다.
// 주의: 이 테이블들은 supabase/migrations/20260824120000_keyword_ranking_history.sql로 정의되어 있지만
// 그 migration을 실제 DB에 적용하기 전까지는 존재하지 않는다. keyword_rankings.headline / seed_query
// 컬럼은 supabase/migrations/20260825090000_keyword_rankings_headline_seed_query.sql에서 추가되며,
// 이 migration을 적용하기 전까지는 아래 insert가 알 수 없는 컬럼 오류로 실패한다. 두 경우 모두
// runKeywordRanking()의 핵심 결과(랭킹 목록)는 항상 정상적으로 반환되어야 하므로, 여기서 발생하는
// 오류는 밖으로 던지지 않고 결과 객체(persisted/error)로만 알린다.

import {
  createDiscoveryRun,
  updateDiscoveryRun,
} from "../../services/supabase/repositories/discoveryRunRepository.js";
import { createKeywordRankings } from "../../services/supabase/repositories/keywordRankingRepository.js";
import type { DiscoveryRunRow } from "../../types/database.js";
import type { RankedKeyword } from "../../types/keywordScoring.js";

export type SaveRankingHistoryInput = {
  startedAt: Date;
  /** 이 run에 사용된 seed 검색어 목록. discovery_runs.seed_queries에 저장된다. */
  seedQueries: string[];
  /** discovery_runs.source. 기본 'naver'. */
  source?: string;
  /** 기타 실행 옵션(예: displayPerQuery, trendRangeDays 등). discovery_runs.metadata에 저장된다. */
  metadata?: Record<string, unknown> | null;
  candidatesCount: number;
  clustersCount: number;
  /** naver API 수집/트렌드 조회 단계에서 발생한 오류 개수. discovery_runs.error_count에 기록한다. */
  errorCount: number;
  ranked: RankedKeyword[];
};

export type SaveRankingHistoryResult = {
  runId: number | null;
  persisted: boolean;
  error?: string;
};

// Supabase(PostgREST) 오류는 Error 인스턴스가 아니라 { message, details, hint, code } 형태의
// 일반 객체로 던져지므로, `error instanceof Error` 분기만으로는 String(error)가 "[object Object]"로
// 뭉개진다. message 속성이 있으면 그것을 우선 사용한다.
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export async function saveRankingHistory(
  input: SaveRankingHistoryInput
): Promise<SaveRankingHistoryResult> {
  let run: DiscoveryRunRow | null = null;

  try {
    run = await createDiscoveryRun({
      started_at: input.startedAt.toISOString(),
      status: "running",
      source: input.source ?? "naver",
      seed_queries: input.seedQueries,
      metadata: input.metadata ?? null,
    });

    if (input.ranked.length > 0) {
      await createKeywordRankings(
        input.ranked.map((item) => ({
          run_id: run!.id,
          keyword_id: null,
          keyword: item.keyword,
          headline: item.headline,
          seed_query: item.seedQuery,
          category: item.category,
          rank: item.rank,
          total_score: item.totalScore,
          trend_score: item.scoreBreakdown.trendMomentum,
          news_score: item.scoreBreakdown.newsVelocity,
          content_score: item.scoreBreakdown.contentDemand,
          freshness_score: item.scoreBreakdown.freshness,
          cross_source_score: item.scoreBreakdown.crossSourceSignal,
          click_score: item.scoreBreakdown.clickPotential,
          trend_direction: item.trendDirection,
          related_count: item.relatedCount,
          sources: item.sources,
          score_breakdown: item.scoreBreakdown,
          reason: item.reason,
          latest_published_at: item.latestPublishedAt,
        }))
      );
    }

    await updateDiscoveryRun(run.id, {
      completed_at: new Date().toISOString(),
      status: "completed",
      candidates_count: input.candidatesCount,
      clusters_count: input.clustersCount,
      inserted_count: input.ranked.length,
      error_count: input.errorCount,
    });

    return { runId: run.id, persisted: true };
  } catch (error) {
    const message = getErrorMessage(error);
    console.error("⚠️ ranking history 저장 실패 -", message);

    if (run) {
      try {
        await updateDiscoveryRun(run.id, { status: "failed" });
      } catch {
        // 상태 업데이트마저 실패하면 원래 오류만 보고하고 무시한다.
      }
    }

    return { runId: run?.id ?? null, persisted: false, error: message };
  }
}
