import type { KeywordProvider } from "./KeywordProvider.js";
import type { RawKeyword } from "../../../types/keywordDiscovery.js";
import { DEFAULT_CATEGORY_BY_QUERY } from "../naver/naverCategoryMap.js";
import {
  NAVER_API_HUB_BASE_URL,
  naverGetJson,
  parseCompactDate,
  sleep,
  stripNaverMarkup,
} from "../naver/naverClient.js";
import {
  blogWindowVerdict,
  paginateUntilWindow,
  type DailyWindowQueryStat,
  type NaverDailyWindowProviderOptions,
} from "../naver/naverDailyWindow.js";

const NAVER_BLOG_SEARCH_URL = `${NAVER_API_HUB_BASE_URL}/search/v1/blog`;

type NaverBlogSearchItem = {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;
};

type NaverBlogSearchResponse = {
  lastBuildDate: string;
  total: number;
  start: number;
  display: number;
  items: NaverBlogSearchItem[];
};

export type NaverBlogKeywordProviderOptions = {
  queries: string[];
  /** query -> category 매핑. 지정하지 않은 query는 DEFAULT_CATEGORY_BY_QUERY를 사용하고, 그것도 없으면 normalizeKeywords의 기본값으로 처리된다. */
  categoryByQuery?: Record<string, string>;
  /** query당 가져올 블로그 개수 (Naver API display, 1~100). 기본 10. */
  displayPerQuery?: number;
  /** "sim"(정확도) | "date"(최신순). 기본 "date". */
  sort?: "sim" | "date";
  /** query 간 순차 호출 사이에 둘 지연 시간(ms). rate limit 보호용. 기본 150ms. */
  requestDelayMs?: number;
  /**
   * 지정하면 검색어마다 "최근 N시간 창"이 찰 때까지 페이지네이션한다(2026-11-25, 엔터 키워드 수집 전용 -
   * naverDailyWindow.ts). 이때 displayPerQuery·sort는 무시하고 sort=date, display=100을 쓴다.
   * 생략하면 기존 동작(display 1장) 그대로다 - 자료조사 수집 등 다른 경로는 넘기지 않는다.
   */
  dailyWindow?: NaverDailyWindowProviderOptions;
};

export class NaverBlogKeywordProvider implements KeywordProvider {
  private readonly queries: string[];
  private readonly categoryByQuery: Record<string, string>;
  private readonly displayPerQuery: number;
  private readonly sort: "sim" | "date";
  private readonly requestDelayMs: number;
  private readonly dailyWindow: NaverDailyWindowProviderOptions | undefined;
  private readonly windowStats: DailyWindowQueryStat[] = [];

  constructor(options: NaverBlogKeywordProviderOptions) {
    this.queries = options.queries;
    this.categoryByQuery = {
      ...DEFAULT_CATEGORY_BY_QUERY,
      ...options.categoryByQuery,
    };
    this.displayPerQuery = options.displayPerQuery ?? 10;
    this.sort = options.sort ?? "date";
    this.requestDelayMs = options.requestDelayMs ?? 150;
    this.dailyWindow = options.dailyWindow;
  }

  /** dailyWindow 모드에서 검색어별 페이지네이션 결과. 모드가 아니면 빈 배열. */
  getWindowStats(): readonly DailyWindowQueryStat[] {
    return this.windowStats;
  }

  async fetchKeywords(): Promise<RawKeyword[]> {
    const rawKeywords: RawKeyword[] = [];
    const errors: string[] = [];

    // query를 무제한 병렬 호출하지 않고 순차적으로 호출한다 (rate limit 보호).
    for (let i = 0; i < this.queries.length; i++) {
      const query = this.queries[i];

      try {
        const items = await this.searchBlog(query);
        rawKeywords.push(...this.toRawKeywords(query, items));
      } catch (error) {
        // 개별 query 실패가 전체 workflow를 중단시키지 않도록 로그만 남기고 계속 진행한다.
        // 단, 모든 query가 실패하면(예: credential 문제) 호출자가 알 수 있도록 마지막에 throw한다.
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        console.error(`⚠️ NaverBlogKeywordProvider: "${query}" 검색 실패 -`, message);
      }

      if (i < this.queries.length - 1 && this.requestDelayMs > 0) {
        await sleep(this.requestDelayMs);
      }
    }

    if (this.queries.length > 0 && errors.length === this.queries.length) {
      throw new Error(`NaverBlogKeywordProvider: 모든 query 검색 실패 - ${errors[0]}`);
    }

    return rawKeywords;
  }

  private async searchBlog(query: string): Promise<NaverBlogSearchItem[]> {
    if (this.dailyWindow) return this.searchBlogDailyWindow(query, this.dailyWindow);
    return this.fetchPage(query, 1, this.displayPerQuery, this.sort);
  }

  private async fetchPage(
    query: string,
    start: number,
    display: number,
    sort: "sim" | "date"
  ): Promise<NaverBlogSearchItem[]> {
    const body = await naverGetJson<NaverBlogSearchResponse>(NAVER_BLOG_SEARCH_URL, {
      params: {
        query,
        display,
        // start=1은 기본값이라 보내지 않는다 - 창 모드가 아닌 기존 요청과 파라미터를 똑같이 유지한다.
        start: start > 1 ? start : undefined,
        sort,
      },
    });
    return body.items ?? [];
  }

  private async searchBlogDailyWindow(
    query: string,
    window: NaverDailyWindowProviderOptions
  ): Promise<NaverBlogSearchItem[]> {
    const now = window.now ?? new Date();
    const result = await paginateUntilWindow<NaverBlogSearchItem>({
      fetchPage: (start, display) => this.fetchPage(query, start, display, "date"),
      verdict: (item) => blogWindowVerdict(item.postdate, now, window.windowHours),
      maxDocs: window.maxDocsPerQuery,
      legacyKeepCount: window.legacyKeepCount,
      budget: window.budget,
      requestDelayMs: this.requestDelayMs,
    });
    if (result.pageError) {
      console.error(
        `⚠️ NaverBlogKeywordProvider: "${query}" ${result.pages + 1}쪽 실패 - 앞 ${result.pages}쪽(${result.items.length}건)으로 진행 -`,
        result.pageError
      );
    }
    this.windowStats.push({
      query,
      pages: result.pages,
      fetched: result.fetched,
      kept: result.items.length,
      droppedOutOfWindow: result.droppedOutOfWindow,
      stopReason: result.stopReason,
    });
    return result.items;
  }

  private toRawKeywords(
    query: string,
    items: NaverBlogSearchItem[]
  ): RawKeyword[] {
    const category = this.categoryByQuery[query];

    return items.map((item, index) => ({
      keyword: stripNaverMarkup(item.title),
      category,
      source: "naver_blog",
      // Naver API는 트렌드 점수를 제공하지 않으므로, 검색 결과 내 순위를 임시 점수로 사용한다.
      trendScore: items.length - index,
      sourceUrl: item.link,
      publishedAt: parseCompactDate(item.postdate),
      metadata: {
        query,
        description: stripNaverMarkup(item.description),
        bloggerName: item.bloggername,
        bloggerLink: item.bloggerlink,
      },
    }));
  }
}
