// 구글 트렌드 수집 -> trend_candidates 저장까지의 배선(collection) 워크플로우.
// runCreatorAdvisorCollection.ts와 같은 계약을 따른다: **어떤 실패에도 throw하지 않고 status로만
// 알린다.** 신규 소스가 daily job을 죽이면 안 되기 때문이다(buildDailyQueryPool.ts fallback 원칙).

import { TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { describeError } from "../../services/describeError.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { fetchGoogleTrends } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";
import { excludeCandidateInserts } from "../keyword-discovery/excludeCandidateInserts.js";
import { GOOGLE_TRENDS_SOURCE, mapGoogleTrendsItemsToInserts } from "./mapGoogleTrendsCandidates.js";
import type { FetchGoogleTrendsResult } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";

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
  /** 제외 카테고리(육아 등)·정치 키워드로 걸러져 저장되지 않은 수(2026-09-07). */
  excludedCount: number;
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
      excludedCount: 0,
      expiredCount: 0,
      trendDate: null,
    };
  }

  try {
    const fetchTrends = options.fetchTrends ?? (() => fetchGoogleTrends({ geo: options.geo }));
    const fetched = await fetchTrends();

    // 매핑은 순수 함수이므로 DB 접근 전에 끝낸다 - 매핑에서 실패하면 원격에 아무것도 쓰지 않는다.
    const { rows: mapped, droppedCount } = mapGoogleTrendsItemsToInserts(fetched.items, {
      collectedAt: fetched.collectedAt,
    });
    const trendDate = mapped[0]?.trend_date ?? fetched.collectedAt.slice(0, 10);

    // 육아 카테고리·정치 키워드는 수집 단계에서 원천 차단한다(2026-09-07 채널 개편).
    const { rows, excludedCount } = excludeCandidateInserts(mapped);

    if (dryRun) {
      return {
        status: "success",
        fetchedCount: fetched.items.length,
        upsertedCount: 0,
        droppedCount,
        excludedCount,
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
      excludedCount,
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
      excludedCount: 0,
      expiredCount: 0,
      trendDate: null,
      error: message,
    };
  }
}
