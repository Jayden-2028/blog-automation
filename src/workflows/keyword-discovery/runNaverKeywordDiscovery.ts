import {
  NaverTrendProvider,
  NAVER_TREND_MAX_GROUPS_PER_REQUEST,
} from "../../services/search/providers/NaverTrendProvider.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";
import type { KeywordRow } from "../../types/database.js";
import { calculateTrendScore } from "./calculateTrendScore.js";
import {
  collectNaverCandidates,
  NAVER_SEARCH_SOURCES,
  type NaverSearchSource,
} from "./collectNaverCandidates.js";
import { saveKeywordCandidates } from "./saveKeywordCandidates.js";

export type NaverApiSource = NaverSearchSource | "naver_trend";

export type RunNaverKeywordDiscoveryOptions = {
  /** query당 API별로 가져올 결과 개수. 실제 API 테스트 시에는 소량(5 정도) 권장. 기본 10. */
  displayPerQuery?: number;
  /** query 간 순차 호출 사이에 둘 지연 시간(ms). rate limit 보호용. 기본 150ms. */
  requestDelayMs?: number;
  /** 검색어트렌드 조회 기간(일). 기본 30일. */
  trendRangeDays?: number;
  trendTimeUnit?: "date" | "week" | "month";
  categoryByQuery?: Record<string, string>;
};

export type NaverKeywordDiscoverySummary = {
  queries: string[];
  apiCallsSucceeded: NaverApiSource[];
  apiErrors: Partial<Record<NaverApiSource, string>>;
  fetched: number;
  duplicateInBatch: number;
  existingInDb: number;
  inserted: number;
  insertedKeywords: KeywordRow[];
};

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchTrendRatioByQuery(
  queries: string[],
  options: RunNaverKeywordDiscoveryOptions,
  apiErrors: Partial<Record<NaverApiSource, string>>
): Promise<{ ratioByQuery: Map<string, number>; succeeded: boolean }> {
  const ratioByQuery = new Map<string, number>();
  if (queries.length === 0) {
    return { ratioByQuery, succeeded: false };
  }

  const trendProvider = new NaverTrendProvider();
  const endDate = new Date();
  const startDate = new Date(
    endDate.getTime() - (options.trendRangeDays ?? 30) * 24 * 60 * 60 * 1000
  );
  const timeUnit = options.trendTimeUnit ?? "date";

  let succeeded = false;

  // DataLab API는 요청당 최대 5개 groupName까지만 허용하므로 query를 batch로 나눠 순차 호출한다.
  for (let i = 0; i < queries.length; i += NAVER_TREND_MAX_GROUPS_PER_REQUEST) {
    const batch = queries.slice(i, i + NAVER_TREND_MAX_GROUPS_PER_REQUEST);

    try {
      const response = await trendProvider.fetchTrendData({
        startDate: toDateString(startDate),
        endDate: toDateString(endDate),
        timeUnit,
        keywordGroups: batch.map((query) => ({ groupName: query, keywords: [query] })),
      });
      succeeded = true;

      for (const result of response.results) {
        const latestRatio = NaverTrendProvider.getLatestRatio(result);
        if (latestRatio !== undefined) {
          ratioByQuery.set(result.title, latestRatio);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiErrors.naver_trend = message;
      console.error("⚠️ naver_trend 조회 실패 -", message);
    }
  }

  return { ratioByQuery, succeeded };
}

function applyTrendScores(
  candidates: KeywordCandidate[],
  scoreByQuery: Map<string, number>
): KeywordCandidate[] {
  return candidates.map((candidate) => {
    const query = typeof candidate.metadata.query === "string" ? candidate.metadata.query : undefined;
    const score = query ? scoreByQuery.get(query) : undefined;
    return score === undefined ? candidate : { ...candidate, trendScore: score };
  });
}

// 뉴스/블로그/웹문서 + 검색어트렌드를 모두 활용하는 실제 운영용 orchestration.
// 흐름: seed 목록 → 뉴스/블로그/웹문서 검색 → normalize/dedup → trend API 조회 → trend score 계산 → Supabase 저장
export async function runNaverKeywordDiscovery(
  queries: string[],
  options: RunNaverKeywordDiscoveryOptions = {}
): Promise<NaverKeywordDiscoverySummary> {
  const apiErrors: Partial<Record<NaverApiSource, string>> = {};

  const collected = await collectNaverCandidates(queries, {
    displayPerQuery: options.displayPerQuery,
    requestDelayMs: options.requestDelayMs,
    categoryByQuery: options.categoryByQuery,
  });

  for (const source of NAVER_SEARCH_SOURCES) {
    if (collected.sourceErrors[source]) {
      apiErrors[source] = collected.sourceErrors[source];
    }
  }

  const { ratioByQuery, succeeded: trendSucceeded } = await fetchTrendRatioByQuery(
    queries,
    options,
    apiErrors
  );

  const scoreByQuery = new Map<string, number>();
  for (const query of queries) {
    const counts = collected.countsByQuery[query] ?? {
      naver_news: 0,
      naver_blog: 0,
      naver_web: 0,
    };
    scoreByQuery.set(
      query,
      calculateTrendScore({
        newsCount: counts.naver_news,
        blogCount: counts.naver_blog,
        webCount: counts.naver_web,
        trendRatio: ratioByQuery.get(query),
      })
    );
  }

  const scoredCandidates = applyTrendScores(collected.candidates, scoreByQuery);
  const { existingInDb, inserted, insertedKeywords } = await saveKeywordCandidates(
    scoredCandidates
  );

  const apiCallsSucceeded: NaverApiSource[] = [];
  for (const source of NAVER_SEARCH_SOURCES) {
    if (!apiErrors[source]) apiCallsSucceeded.push(source);
  }
  if (trendSucceeded) apiCallsSucceeded.push("naver_trend");

  return {
    queries,
    apiCallsSucceeded,
    apiErrors,
    fetched: collected.rawKeywords.length,
    duplicateInBatch: collected.duplicateInBatch,
    existingInDb,
    inserted,
    insertedKeywords,
  };
}
