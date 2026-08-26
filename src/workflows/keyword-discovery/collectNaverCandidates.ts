import { NaverBlogKeywordProvider } from "../../services/search/providers/NaverBlogKeywordProvider.js";
import { NaverNewsKeywordProvider } from "../../services/search/providers/NaverNewsKeywordProvider.js";
import { NaverWebKeywordProvider } from "../../services/search/providers/NaverWebKeywordProvider.js";
import type {
  KeywordCandidate,
  NormalizedKeyword,
  RawKeyword,
} from "../../types/keywordDiscovery.js";
import { deduplicateKeywords } from "./deduplicateKeywords.js";
import { normalizeKeywords } from "./normalizeKeywords.js";

export const NAVER_SEARCH_SOURCES = ["naver_news", "naver_blog", "naver_web"] as const;
export type NaverSearchSource = (typeof NAVER_SEARCH_SOURCES)[number];

export type NaverSearchCounts = Record<NaverSearchSource, number>;

export type CollectNaverCandidatesOptions = {
  /** query당 API별로 가져올 결과 개수. 기본 10. 실제 API 테스트 시에는 소량(5 정도)을 권장. */
  displayPerQuery?: number;
  /** query 간 순차 호출 사이에 둘 지연 시간(ms). rate limit 보호용. 기본 150ms. */
  requestDelayMs?: number;
  categoryByQuery?: Record<string, string>;
};

export type CollectNaverCandidatesResult = {
  rawKeywords: RawKeyword[];
  normalizedKeywords: NormalizedKeyword[];
  candidates: KeywordCandidate[];
  duplicateInBatch: number;
  /** query별로 뉴스/블로그/웹문서 검색에서 몇 건이 나왔는지. trend score 계산에 사용된다. */
  countsByQuery: Record<string, NaverSearchCounts>;
  /** 소스별 조회 실패 시 에러 메시지. 성공한 소스는 key가 없다. */
  sourceErrors: Partial<Record<NaverSearchSource, string>>;
};

async function safeFetchKeywords(
  source: NaverSearchSource,
  fetchKeywords: () => Promise<RawKeyword[]>,
  sourceErrors: Partial<Record<NaverSearchSource, string>>
): Promise<RawKeyword[]> {
  try {
    return await fetchKeywords();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sourceErrors[source] = message;
    console.error(`⚠️ ${source} 조회 실패 -`, message);
    return [];
  }
}

// Naver 뉴스 + 블로그 + 웹문서 검색 결과를 하나로 모아 normalize/deduplicate까지 수행한다.
// rate limit 보호를 위해 소스별 호출은 순차적으로 진행한다 (각 provider 내부의 query 루프도 순차적).
export async function collectNaverCandidates(
  queries: string[],
  options: CollectNaverCandidatesOptions = {}
): Promise<CollectNaverCandidatesResult> {
  const sourceErrors: Partial<Record<NaverSearchSource, string>> = {};

  const providerOptions = {
    queries,
    displayPerQuery: options.displayPerQuery,
    requestDelayMs: options.requestDelayMs,
    categoryByQuery: options.categoryByQuery,
  };

  const newsKeywords = await safeFetchKeywords(
    "naver_news",
    () => new NaverNewsKeywordProvider(providerOptions).fetchKeywords(),
    sourceErrors
  );
  const blogKeywords = await safeFetchKeywords(
    "naver_blog",
    () => new NaverBlogKeywordProvider(providerOptions).fetchKeywords(),
    sourceErrors
  );
  const webKeywords = await safeFetchKeywords(
    "naver_web",
    () => new NaverWebKeywordProvider(providerOptions).fetchKeywords(),
    sourceErrors
  );

  const keywordsBySource: Record<NaverSearchSource, RawKeyword[]> = {
    naver_news: newsKeywords,
    naver_blog: blogKeywords,
    naver_web: webKeywords,
  };

  const countsByQuery: Record<string, NaverSearchCounts> = {};
  for (const query of queries) {
    countsByQuery[query] = {
      naver_news: newsKeywords.filter((item) => item.metadata?.query === query).length,
      naver_blog: blogKeywords.filter((item) => item.metadata?.query === query).length,
      naver_web: webKeywords.filter((item) => item.metadata?.query === query).length,
    };
  }

  const rawKeywords = [
    ...keywordsBySource.naver_news,
    ...keywordsBySource.naver_blog,
    ...keywordsBySource.naver_web,
  ];

  const normalizedKeywords = normalizeKeywords(rawKeywords);
  const { candidates, duplicateCount } = deduplicateKeywords(normalizedKeywords);

  return {
    rawKeywords,
    normalizedKeywords,
    candidates,
    duplicateInBatch: duplicateCount,
    countsByQuery,
    sourceErrors,
  };
}
