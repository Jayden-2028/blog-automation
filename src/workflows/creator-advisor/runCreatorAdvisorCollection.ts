// Creator Advisor 트렌드 탭 수집 -> trend_candidates 저장까지의 배선(collection) 워크플로우.
//
// 이 파일이 필요한 이유: 개별 조각(BrowserCreatorAdvisorProvider로 크롤링,
// mapCreatorAdvisorCandidatesToInserts로 변환, TrendCandidateRepository.upsertCandidates로 저장)은
// 모두 완성되어 있었지만 프로덕션 경로에서 이들을 이어 호출하는 코드가 없었다. 그 결과
// buildDailyQueryPool()은 아무도 쓰지 않는 trend_candidates를 읽고 있었고, CREATOR_ADVISOR_ENABLED를
// 켜도 항상 trendCount=0이 나왔다. 이 워크플로우가 그 빠진 연결을 담당한다.
//
// 실패 처리 원칙(buildDailyQueryPool.ts와 동일): Creator Advisor는 seed_queries 파이프라인을
// 보강하는 enrichment source일 뿐 필수 의존성이 아니다. 따라서 이 함수는 로그인 만료/페이지 구조
// 변경/timeout 등 어떤 사유로 실패해도 예외를 밖으로 던지지 않고 status: "failed" 결과를 반환한다 -
// daily workflow가 이 소스 없이 seed_queries만으로 계속 진행할 수 있어야 하기 때문이다.

import { CREATOR_ADVISOR_CONFIG } from "../../config/creatorAdvisor.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { BrowserCreatorAdvisorProvider } from "../../services/search/providers/BrowserCreatorAdvisorProvider.js";
import {
  dedupeTrendCandidateInserts,
  mapCreatorAdvisorCandidatesToInserts,
} from "./mapCreatorAdvisorCandidates.js";
import type { FetchTrendKeywordsResult } from "../../services/search/providers/BrowserCreatorAdvisorProvider.js";

const CREATOR_ADVISOR_SOURCE = "creator_advisor";

/**
 * Supabase(PostgrestError)는 Error 인스턴스가 아니라 { message, details, hint, code } 형태의 평범한
 * 객체다 - String(error)로 감싸면 "[object Object]"가 되어 실패 원인이 통째로 사라진다. 이 파이프라인은
 * 실패를 예외 대신 문자열로만 전달하므로, 여기서 최대한 원인을 보존한다.
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

export type RunCreatorAdvisorCollectionOptions = {
  /** 생략하면 CREATOR_ADVISOR_CONFIG.enabled. false면 크롤링/저장 없이 skipped로 즉시 반환한다. */
  enabled?: boolean;
  /**
   * true면 크롤링과 매핑까지만 하고 trend_candidates 쓰기(upsert/expire)는 건너뛴다.
   * 원격 DB 쓰기 승인 전에 크롤링 경로만 검증할 때 쓴다.
   */
  dryRun?: boolean;
  /** 만료 처리(expireOldCandidates)를 건너뛴다. 기본 false. */
  skipExpire?: boolean;
  /** 테스트에서 실제 브라우저 대신 수집 결과를 주입하는 지점. */
  fetchCandidates?: () => Promise<FetchTrendKeywordsResult>;
};

export type RunCreatorAdvisorCollectionResult = {
  status: "success" | "skipped" | "failed";
  /** status="skipped"일 때의 사유. */
  reason?: "disabled";
  /** 크롤링으로 얻은 후보 수(매핑 전). */
  fetchedCount: number;
  /** 실제 trend_candidates에 upsert된 row 수. dryRun이면 0. */
  upsertedCount: number;
  /** status='expired'로 전환된 기존 row 수. dryRun/skipExpire면 0. */
  expiredCount: number;
  /** 실제 파싱에 쓰인 트렌드 기준일. */
  trendDate: string | null;
  /** topic card 단위 부분 실패(페이지 전체 실패가 아님). */
  topicErrors: Record<string, string>;
  /** status="failed"일 때의 오류 메시지. */
  error?: string;
};

/**
 * Creator Advisor를 1회 수집해 trend_candidates에 upsert한다.
 * 어떤 실패에도 throw하지 않는다 - 호출자는 반환된 status로 판단한다.
 */
export async function runCreatorAdvisorCollection(
  options: RunCreatorAdvisorCollectionOptions = {}
): Promise<RunCreatorAdvisorCollectionResult> {
  const enabled = options.enabled ?? CREATOR_ADVISOR_CONFIG.enabled;
  const dryRun = options.dryRun ?? false;

  const empty: RunCreatorAdvisorCollectionResult = {
    status: "skipped",
    reason: "disabled",
    fetchedCount: 0,
    upsertedCount: 0,
    expiredCount: 0,
    trendDate: null,
    topicErrors: {},
  };

  if (!enabled) return empty;

  try {
    const fetchCandidates =
      options.fetchCandidates ??
      (() => new BrowserCreatorAdvisorProvider().fetchTrendKeywordsDetailed());

    const fetched = await fetchCandidates();

    // 매핑은 순수 함수이므로 DB 접근 전에 끝낸다 - 매핑 단계에서 실패하면 원격에 아무것도 쓰지 않는다.
    // 같은 키워드가 같은 내부 카테고리의 서로 다른 topic에 동시에 등장하면 unique index conflict key가
    // 배치 안에서 겹쳐 upsert 전체가 거부된다(21000). 그래서 DB에 보내기 전에 병합한다.
    const mapped = mapCreatorAdvisorCandidatesToInserts(fetched.candidates);
    const { rows, droppedCount } = dedupeTrendCandidateInserts(mapped);
    if (droppedCount > 0) {
      console.log(
        `\u2139\uFE0F runCreatorAdvisorCollection: 같은 카테고리 내 중복 ${droppedCount}건을 병합했습니다 ` +
          `(${mapped.length}건 -> ${rows.length}건).`
      );
    }

    if (dryRun) {
      return {
        status: "success",
        fetchedCount: fetched.candidates.length,
        upsertedCount: 0,
        expiredCount: 0,
        trendDate: fetched.latestAvailableTrendDate ?? fetched.trendDate,
        topicErrors: fetched.topicErrors,
      };
    }

    const upserted = await TrendCandidateRepository.upsertCandidates(rows);

    // 만료 처리는 upsert 뒤에 한다 - 먼저 만료시키면 같은 실행에서 방금 넣은 row가
    // (expires_at 계산이 과거로 잡힌 경우) 곧바로 expired가 될 수 있다.
    const expiredCount = options.skipExpire
      ? 0
      : await TrendCandidateRepository.expireOldCandidates({ source: CREATOR_ADVISOR_SOURCE });

    return {
      status: "success",
      fetchedCount: fetched.candidates.length,
      upsertedCount: upserted.length,
      expiredCount,
      trendDate: fetched.latestAvailableTrendDate ?? fetched.trendDate,
      topicErrors: fetched.topicErrors,
    };
  } catch (error) {
    const message = describeError(error);
    console.error("⚠️ runCreatorAdvisorCollection 실패 - seed_queries만으로 진행됩니다 -", message);
    return {
      status: "failed",
      fetchedCount: 0,
      upsertedCount: 0,
      expiredCount: 0,
      trendDate: null,
      topicErrors: {},
      error: message,
    };
  }
}
