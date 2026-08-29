// 구글 트렌드 수집 -> trend_candidates 저장까지의 배선(collection) 워크플로우.
// runCreatorAdvisorCollection.ts와 같은 계약을 따른다: **어떤 실패에도 throw하지 않고 status로만
// 알린다.** 신규 소스가 daily job을 죽이면 안 되기 때문이다(buildDailyQueryPool.ts fallback 원칙).

import { TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { fetchGoogleTrends } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";
import { GOOGLE_TRENDS_SOURCE, mapGoogleTrendsItemsToInserts } from "./mapGoogleTrendsCandidates.js";
import type { FetchGoogleTrendsResult } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";

/**
 * Supabase(PostgrestError)는 Error 인스턴스가 아니라 평범한 객체라 String(error)가
 * "[object Object]"를 만든다. runCreatorAdvisorCollection.ts와 같은 이유로 원인을 보존한다.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [
      typeof e.message === "string" ? e.message : null,
      typeof e.code === "string" ? `code=${e.code}` : null,
      typeof e.details === "string" && e.details ? `details=${e.details}` : null,
      typeof e.hint === "string" && e.hint ? `hint=${e.hint}` : null,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" | ");

    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }

  return String(error);
}

export type RunGoogleTrendsCollectionOptions = {
  /** 생략하면 TREND_SOURCE_CONFIGS.google_trends.enabled. false면 즉시 skipped. */
  enabled?: boolean;
  /** true면 조회/매핑까지만 하고 trend_candidates 쓰기(upsert/expire)를 건너뛴다. */
  dryRun?: boolean;
  /** 만료 처리(expireOldCandidates)를 건너뛴다. 기본 false. */
  skipExpire?: boolean;
  geo?: string;
  /** 테스트에서 실제 네트워크 대신 결과를 주입하는 지점. */
  fetchTrends?: () => Promise<FetchGoogleTrendsResult>;
};

export type RunGoogleTrendsCollectionResult = {
  status: "success" | "skipped" | "failed";
  reason?: "disabled";
  /** RSS에서 파싱된 항목 수(매핑 전). */
  fetchedCount: number;
  /** 실제 upsert된 row 수. dryRun이면 0. */
  upsertedCount: number;
  /** 중복 키워드로 버려진 수. */
  droppedCount: number;
  /** status='expired'로 전환된 기존 row 수. dryRun/skipExpire면 0. */
  expiredCount: number;
  trendDate: string | null;
  error?: string;
};

export async function runGoogleTrendsCollection(
  options: RunGoogleTrendsCollectionOptions = {}
): Promise<RunGoogleTrendsCollectionResult> {
  const enabled = options.enabled ?? TREND_SOURCE_CONFIGS.google_trends.enabled;
  const dryRun = options.dryRun ?? false;

  if (!enabled) {
    return {
      status: "skipped",
      reason: "disabled",
      fetchedCount: 0,
      upsertedCount: 0,
      droppedCount: 0,
      expiredCount: 0,
      trendDate: null,
    };
  }

  try {
    const fetchTrends = options.fetchTrends ?? (() => fetchGoogleTrends({ geo: options.geo }));
    const fetched = await fetchTrends();

    // 매핑은 순수 함수이므로 DB 접근 전에 끝낸다 - 매핑에서 실패하면 원격에 아무것도 쓰지 않는다.
    const { rows, droppedCount } = mapGoogleTrendsItemsToInserts(fetched.items, {
      collectedAt: fetched.collectedAt,
    });
    const trendDate = rows[0]?.trend_date ?? fetched.collectedAt.slice(0, 10);

    if (dryRun) {
      return {
        status: "success",
        fetchedCount: fetched.items.length,
        upsertedCount: 0,
        droppedCount,
        expiredCount: 0,
        trendDate,
      };
    }

    const upserted = await TrendCandidateRepository.upsertCandidates(rows);

    // 만료는 이 source로 한정한다. 생략하면 다른 소스의 row까지 만료시킨다.
    const expiredCount = options.skipExpire
      ? 0
      : await TrendCandidateRepository.expireOldCandidates({ source: GOOGLE_TRENDS_SOURCE });

    return {
      status: "success",
      fetchedCount: fetched.items.length,
      upsertedCount: upserted.length,
      droppedCount,
      expiredCount,
      trendDate,
    };
  } catch (error) {
    const message = describeError(error);
    console.error("⚠️ [runGoogleTrendsCollection] 수집 실패 -", message);
    return {
      status: "failed",
      fetchedCount: 0,
      upsertedCount: 0,
      droppedCount: 0,
      expiredCount: 0,
      trendDate: null,
      error: message,
    };
  }
}
