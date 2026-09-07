// 커뮤니티 수집 -> trend_candidates 저장까지의 배선(collection) 워크플로우.
// runGoogleTrendsCollection.ts와 같은 계약을 따른다: **어떤 실패에도 throw하지 않고 status로만
// 알린다.** daily job을 죽이면 안 되기 때문이다(buildDailyQueryPool.ts fallback 원칙).
//
// 사이트별 provider 실패는 여기서 격리한다(buildDailyQueryPool.ts의 소스별 try/catch와 같은 원칙) -
// 사이트 하나가 죽어도(로그인 필요/차단/timeout 등) 나머지 사이트로 계속 진행한다. 지금은
// COMMUNITY_SOURCE_PROVIDERS가 비어 있어(CommunitySource.ts 주석 참고) 이 워크플로우는 실제로는
// 항상 "0건 수집 + 성공"을 반환하지만, provider가 하나씩 붙어도 이 파일은 손댈 필요가 없도록
// 설계했다.

import { TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { describeError } from "../../services/describeError.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { COMMUNITY_SOURCE_PROVIDERS, type CommunitySourceProvider } from "../../services/community/CommunitySource.js";
import {
  extractCommunityKeywords,
  type CommunityPostInput,
  type ExtractCommunityKeywordsOptions,
} from "./extractCommunityKeywords.js";
import { excludeCandidateInserts } from "../keyword-discovery/excludeCandidateInserts.js";
import { COMMUNITY_SOURCE, mapCommunityItemsToInserts } from "./mapCommunityCandidates.js";

export type RunCommunityCollectionOptions = {
  /** 생략하면 TREND_SOURCE_CONFIGS.community.enabled. false면 즉시 skipped. */
  enabled?: boolean;
  /** true면 조회/추출/매핑까지만 하고 trend_candidates 쓰기(upsert/expire)를 건너뛴다. */
  dryRun?: boolean;
  /** 만료 처리(expireOldCandidates)를 건너뛴다. 기본 false. */
  skipExpire?: boolean;
  /** 테스트/단계적 롤아웃에서 실제 사이트 목록 대신 주입하는 지점. 생략하면 COMMUNITY_SOURCE_PROVIDERS. */
  sources?: readonly CommunitySourceProvider[];
  /** 테스트에서 실제 LLM 호출 대신 결과를 주입하는 지점. */
  extractKeywords?: (
    posts: readonly CommunityPostInput[],
    options?: ExtractCommunityKeywordsOptions
  ) => ReturnType<typeof extractCommunityKeywords>;
  /** 수집 시각 ISO. 생략하면 실행 시각. 테스트에서 trend_date를 고정할 때 쓴다. */
  collectedAt?: string;
};

export type RunCommunityCollectionResult = {
  status: "success" | "skipped" | "failed";
  reason?: "disabled";
  /** 사이트에서 조회된 인기글 총합(추출 전). */
  fetchedCount: number;
  /** 실제 upsert된 row 수. dryRun이면 0. */
  upsertedCount: number;
  /** 중복/너무 짧은 키워드로 버려진 수. */
  droppedCount: number;
  /** 제외 카테고리(육아 등)·정치 키워드로 걸러져 저장되지 않은 수(2026-09-07). */
  excludedCount: number;
  /** status='expired'로 전환된 기존 row 수. dryRun/skipExpire면 0. */
  expiredCount: number;
  trendDate: string | null;
  /** 예외로 전체가 실패했을 때만 채워진다. */
  error?: string;
  /** 조회에 실패한 사이트가 있을 때만 채워진다. 실패해도 나머지 사이트로 진행한다. */
  sourceErrors?: Record<string, string>;
  /** LLM 추출 호출 자체가 실패했을 때만 채워진다(전체 status는 여전히 success - 비치명적). */
  extractionError?: string;
};

export async function runCommunityCollection(
  options: RunCommunityCollectionOptions = {}
): Promise<RunCommunityCollectionResult> {
  const enabled = options.enabled ?? TREND_SOURCE_CONFIGS.community.enabled;
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
    const providers = options.sources ?? COMMUNITY_SOURCE_PROVIDERS;
    const extractKeywords = options.extractKeywords ?? extractCommunityKeywords;
    const collectedAt = options.collectedAt ?? new Date().toISOString();

    const posts: CommunityPostInput[] = [];
    const sourceErrors: Record<string, string> = {};

    for (const provider of providers) {
      try {
        const fetched = await provider.fetchPosts();
        for (const post of fetched) {
          posts.push({ site: provider.site, title: post.title, siteRank: post.siteRank });
        }
      } catch (error) {
        // 사이트 하나가 실패해도 나머지 사이트로 계속 진행한다(파일 상단 주석).
        const message = describeError(error);
        sourceErrors[provider.site] = message;
        console.error(`⚠️ [runCommunityCollection] "${provider.label}" 조회 실패, 나머지로 진행 -`, message);
      }
    }

    const fetchedCount = posts.length;
    const trendDate = collectedAt.slice(0, 10);
    const sourceErrorsResult = Object.keys(sourceErrors).length > 0 ? sourceErrors : undefined;

    // 수집된 글이 하나도 없으면 LLM을 호출하지 않는다(extractCommunityKeywords 자체도 같은
    // 가드를 두지만, "이번 run에 콜을 안 썼다"를 여기 로직으로도 명확히 한다).
    if (fetchedCount === 0) {
      return {
        status: "success",
        fetchedCount: 0,
        upsertedCount: 0,
        droppedCount: 0,
        excludedCount: 0,
        expiredCount: 0,
        trendDate,
        ...(sourceErrorsResult ? { sourceErrors: sourceErrorsResult } : {}),
      };
    }

    const extracted = await extractKeywords(posts);
    const { rows: mapped, droppedCount } = mapCommunityItemsToInserts(posts, extracted.items, { collectedAt });

    // 육아 카테고리·정치 키워드는 수집 단계에서 원천 차단한다(2026-09-07 채널 개편).
    const { rows, excludedCount } = excludeCandidateInserts(mapped);

    if (dryRun) {
      return {
        status: "success",
        fetchedCount,
        upsertedCount: 0,
        droppedCount,
        excludedCount,
        expiredCount: 0,
        trendDate,
        ...(sourceErrorsResult ? { sourceErrors: sourceErrorsResult } : {}),
        ...(extracted.error ? { extractionError: extracted.error } : {}),
      };
    }

    const upserted = await TrendCandidateRepository.upsertCandidates(rows);

    // 만료는 이 source로 한정한다(runGoogleTrendsCollection.ts와 같은 이유).
    const expiredCount = options.skipExpire
      ? 0
      : await TrendCandidateRepository.expireOldCandidates({ source: COMMUNITY_SOURCE });

    return {
      status: "success",
      fetchedCount,
      upsertedCount: upserted.length,
      droppedCount,
      excludedCount,
      expiredCount,
      trendDate,
      ...(sourceErrorsResult ? { sourceErrors: sourceErrorsResult } : {}),
      ...(extracted.error ? { extractionError: extracted.error } : {}),
    };
  } catch (error) {
    const message = describeError(error);
    console.error("⚠️ [runCommunityCollection] 수집 실패 -", message);
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
