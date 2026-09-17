// 네이버 지식iN·카페글·백과사전 검색(API HUB `/search/v1/{kin,cafearticle,encyc}`) 공용 provider
// (2026-09-18, 사용자가 Application에 세 API를 켠 뒤 추가).
//
// 왜 하나로 묶었나: 세 API의 응답이 title/link/description 공통 필드로 충분히 같다. 뉴스·블로그처럼
// 클래스를 셋 더 복제하면 같은 순차 호출·에러 집계 코드가 네 벌이 된다.
//
// 왜 필요한가(기획 품질 딥다이브): researcher.md §5 "사람들이 실제로 묻는 질문"은 지식iN·카페 원문을
// 요구하는데, 에이전트가 WebSearch로는 그 글을 못 찾아 두 번 다 "찾지 못함"으로 끝났다(분장놀이·
// 이재시). API로 치면 바로 나온다 - 제목 자체가 독자의 질문이라 기획 브리프의 Q1~Q5 재료로도 쓴다.
// 백과사전은 Q1(정의)의 근거다.

import type { KeywordProvider } from "./KeywordProvider.js";
import type { RawKeyword } from "../../../types/keywordDiscovery.js";
import { NAVER_API_HUB_BASE_URL, naverGetJson, sleep, stripNaverMarkup } from "../naver/naverClient.js";

export type NaverSimpleSearchKind = "kin" | "cafearticle" | "encyc";

/** sources.source_name / RawKeyword.source 값. classifySourceAuthority가 이 이름으로 등급을 매긴다. */
export const NAVER_SIMPLE_SOURCE_NAME: Record<NaverSimpleSearchKind, "naver_kin" | "naver_cafe" | "naver_encyc"> = {
  kin: "naver_kin",
  cafearticle: "naver_cafe",
  encyc: "naver_encyc",
};

type NaverSimpleItem = { title?: string; link?: string; description?: string; cafename?: string; cafeurl?: string };
type NaverSimpleResponse = { total?: number; items?: NaverSimpleItem[] };

export type NaverSimpleSearchProviderOptions = {
  kind: NaverSimpleSearchKind;
  queries: string[];
  /** query당 결과 수(1~100). 기본 10. */
  displayPerQuery?: number;
  /** "sim"(정확도) | "date"(최신순). 지식iN·카페는 질문의 대표성이 중요해 기본 "sim". */
  sort?: "sim" | "date";
  requestDelayMs?: number;
};

export class NaverSimpleSearchProvider implements KeywordProvider {
  private readonly kind: NaverSimpleSearchKind;
  private readonly queries: string[];
  private readonly displayPerQuery: number;
  private readonly sort: "sim" | "date";
  private readonly requestDelayMs: number;

  constructor(options: NaverSimpleSearchProviderOptions) {
    this.kind = options.kind;
    this.queries = options.queries;
    this.displayPerQuery = options.displayPerQuery ?? 10;
    this.sort = options.sort ?? "sim";
    this.requestDelayMs = options.requestDelayMs ?? 150;
  }

  async fetchKeywords(): Promise<RawKeyword[]> {
    const out: RawKeyword[] = [];
    const errors: string[] = [];
    const url = `${NAVER_API_HUB_BASE_URL}/search/v1/${this.kind}`;
    const source = NAVER_SIMPLE_SOURCE_NAME[this.kind];

    for (let i = 0; i < this.queries.length; i += 1) {
      const query = this.queries[i];
      try {
        const body = await naverGetJson<NaverSimpleResponse>(url, {
          params: { query, display: this.displayPerQuery, sort: this.sort },
        });
        const items = (body.items ?? []).filter((item) => typeof item.link === "string" && item.link);
        out.push(
          ...items.map((item, index) => ({
            keyword: stripNaverMarkup(item.title ?? ""),
            source,
            trendScore: items.length - index,
            sourceUrl: item.link,
            metadata: {
              query,
              description: stripNaverMarkup(item.description ?? ""),
              ...(item.cafename ? { cafeName: item.cafename, cafeUrl: item.cafeurl } : {}),
            },
          }))
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        console.error(`⚠️ NaverSimpleSearchProvider(${this.kind}): "${query}" 검색 실패 -`, message);
      }
      if (i < this.queries.length - 1 && this.requestDelayMs > 0) await sleep(this.requestDelayMs);
    }

    if (this.queries.length > 0 && errors.length === this.queries.length) {
      throw new Error(`NaverSimpleSearchProvider(${this.kind}): 모든 query 검색 실패 - ${errors[0]}`);
    }
    return out;
  }
}
