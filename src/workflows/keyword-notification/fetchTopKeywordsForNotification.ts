// run이 지정되면(dailyKeywordWorkflow가 방금 만든 run 등) 그 run의 keyword_rankings TOP N을,
// 지정되지 않으면 가장 최근에 완료된 discovery_run을 찾아 조회한다.
// keyword_rankings는 runKeywordRanking()/rankKeywords()가 이미 rank 1..topN까지만 저장하므로
// (saveRankingHistory.ts), 여기서는 별도 재정렬/재계산 없이 그대로 rank 순으로 조회하면 된다.
// DB schema는 건드리지 않는다.

import {
  getDiscoveryRunById,
  getLatestCompletedDiscoveryRun,
} from "../../services/supabase/repositories/discoveryRunRepository.js";
import { listKeywordRankingsByRunId } from "../../services/supabase/repositories/keywordRankingRepository.js";
import type { NotificationKeywordItem, NotificationSourceRun } from "../../types/keywordNotification.js";

export type FetchTopKeywordsResult = {
  run: NotificationSourceRun;
  items: NotificationKeywordItem[];
} | null;

export async function fetchTopKeywordsForNotification(
  topN = 10,
  runId?: number
): Promise<FetchTopKeywordsResult> {
  const run = runId !== undefined ? await getDiscoveryRunById(runId) : await getLatestCompletedDiscoveryRun();
  if (!run) return null;

  const rankings = await listKeywordRankingsByRunId(run.id);
  if (rankings.length === 0) return null;

  const items = rankings.slice(0, topN).map((row) => ({
    rank: row.rank,
    keyword: row.keyword,
    headline: row.headline,
    seedQuery: row.seed_query,
    category: row.category,
    totalScore: row.total_score,
    scoreBreakdown: row.score_breakdown,
    trendDirection: row.trend_direction,
    // sendKeywordNotification이 generateKeywordSummaries로 채운다(이 함수는 순수 DB 조회만 한다).
    summary: null,
  }));

  const categories = Array.from(
    new Set(items.map((item) => item.category).filter((category): category is string => Boolean(category)))
  );

  return {
    run: {
      id: run.id,
      startedAt: run.started_at,
      seedQueries: run.seed_queries ?? [],
      activeSeedsCount: run.seed_queries?.length ?? 0,
      candidatesCount: run.candidates_count,
      clustersCount: run.clusters_count,
      categories,
    },
    items,
  };
}
