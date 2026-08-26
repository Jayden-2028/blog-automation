import type { KeywordProvider } from "./KeywordProvider.js";
import type { RawKeyword } from "../../../types/keywordDiscovery.js";
import { DEFAULT_CATEGORY_BY_QUERY } from "../naver/naverCategoryMap.js";
import {
  NAVER_API_HUB_BASE_URL,
  naverGetJson,
  parseRfc822Date,
  sleep,
  stripNaverMarkup,
} from "../naver/naverClient.js";

const NAVER_NEWS_SEARCH_URL = `${NAVER_API_HUB_BASE_URL}/search/v1/news`;

type NaverNewsSearchItem = {
  title: string;
  originallink: string;
  link: string;
  description: string;
  pubDate: string;
};

type NaverNewsSearchResponse = {
  lastBuildDate: string;
  total: number;
  start: number;
  display: number;
  items: NaverNewsSearchItem[];
};

export type NaverNewsKeywordProviderOptions = {
  queries: string[];
  /** query -> category 매핑. 지정하지 않은 query는 DEFAULT_CATEGORY_BY_QUERY를 사용하고, 그것도 없으면 normalizeKeywords의 기본값으로 처리된다. */
  categoryByQuery?: Record<string, string>;
  /** query당 가져올 뉴스 개수 (Naver API display, 1~100). 기본 10. */
  displayPerQuery?: number;
  /** "sim"(정확도) | "date"(최신순). 기본 "date". */
  sort?: "sim" | "date";
  /** query 간 순차 호출 사이에 둘 지연 시간(ms). rate limit 보호용. 기본 150ms. */
  requestDelayMs?: number;
};

export class NaverNewsKeywordProvider implements KeywordProvider {
  private readonly queries: string[];
  private readonly categoryByQuery: Record<string, string>;
  private readonly displayPerQuery: number;
  private readonly sort: "sim" | "date";
  private readonly requestDelayMs: number;

  constructor(options: NaverNewsKeywordProviderOptions) {
    this.queries = options.queries;
    this.categoryByQuery = {
      ...DEFAULT_CATEGORY_BY_QUERY,
      ...options.categoryByQuery,
    };
    this.displayPerQuery = options.displayPerQuery ?? 10;
    this.sort = options.sort ?? "date";
    this.requestDelayMs = options.requestDelayMs ?? 150;
  }

  async fetchKeywords(): Promise<RawKeyword[]> {
    const rawKeywords: RawKeyword[] = [];
    const errors: string[] = [];

    // query를 무제한 병렬 호출하지 않고 순차적으로 호출한다 (rate limit 보호).
    for (let i = 0; i < this.queries.length; i++) {
      const query = this.queries[i];

      try {
        const items = await this.searchNews(query);
        rawKeywords.push(...this.toRawKeywords(query, items));
      } catch (error) {
        // 개별 query 실패가 전체 workflow를 중단시키지 않도록 로그만 남기고 계속 진행한다.
        // 단, 모든 query가 실패하면(예: credential 문제) 호출자가 알 수 있도록 마지막에 throw한다.
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        console.error(`⚠️ NaverNewsKeywordProvider: "${query}" 검색 실패 -`, message);
      }

      if (i < this.queries.length - 1 && this.requestDelayMs > 0) {
        await sleep(this.requestDelayMs);
      }
    }

    if (this.queries.length > 0 && errors.length === this.queries.length) {
      throw new Error(`NaverNewsKeywordProvider: 모든 query 검색 실패 - ${errors[0]}`);
    }

    return rawKeywords;
  }

  private async searchNews(query: string): Promise<NaverNewsSearchItem[]> {
    const body = await naverGetJson<NaverNewsSearchResponse>(NAVER_NEWS_SEARCH_URL, {
      params: {
        query,
        display: this.displayPerQuery,
        sort: this.sort,
      },
    });
    return body.items ?? [];
  }

  private toRawKeywords(
    query: string,
    items: NaverNewsSearchItem[]
  ): RawKeyword[] {
    const category = this.categoryByQuery[query];

    return items.map((item, index) => ({
      keyword: stripNaverMarkup(item.title),
      category,
      source: "naver_news",
      // Naver API는 트렌드 점수를 제공하지 않으므로, 검색 결과 내 순위를 임시 점수로 사용한다.
      trendScore: items.length - index,
      sourceUrl: item.originallink || item.link,
      publishedAt: parseRfc822Date(item.pubDate),
      metadata: {
        query,
        description: stripNaverMarkup(item.description),
        link: item.link,
      },
    }));
  }
}
