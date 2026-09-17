// 선택된 job(article_jobs)의 키워드로 NAVER 뉴스/웹문서/블로그를 재검색해 근거(sources)를 모은다.
//
// 왜 기존 provider를 그대로 쓰는가: NaverWebKeywordProvider 등은 "키워드 발굴"용으로 만들어졌지만,
// 반환하는 RawKeyword가 이미 title/url/snippet/publishedAt을 전부 담고 있다(keyword 필드가 곧
// 검색 결과의 제목이다). 자료조사에 필요한 게 정확히 이 구조라서 새 NAVER API 호출 코드를 만들지
// 않고 이 provider들을 "검색 결과 수집기"로 재사용한다.
//
// 실패 처리: 세 provider(뉴스/웹/블로그) 중 일부가 실패해도 나머지 결과로 계속 진행한다
// (buildDailyQueryPool.ts, runCreatorAdvisorCollection.ts와 같은 관례). 셋 다 실패했을 때만
// 호출자에게 에러로 알린다 - 그래야 job을 재시도할지 판단할 수 있다.

import { NaverBlogKeywordProvider } from "../../services/search/providers/NaverBlogKeywordProvider.js";
import { NaverNewsKeywordProvider } from "../../services/search/providers/NaverNewsKeywordProvider.js";
import { NaverWebKeywordProvider } from "../../services/search/providers/NaverWebKeywordProvider.js";
import { NaverSimpleSearchProvider } from "../../services/search/providers/NaverSimpleSearchProvider.js";
import { classifySourceAuthority } from "../../config/sourceAuthorityRules.js";
import type { KeywordProvider } from "../../services/search/providers/KeywordProvider.js";
import type { RawKeyword } from "../../types/keywordDiscovery.js";
import type { SourceInsert } from "../../types/database.js";

export type CollectSourcesForJobOptions = {
  /** 검색 소스별로 가져올 결과 수. 기본 5건씩(뉴스/웹/블로그/지식iN/카페) + 백과 2건. */
  displayPerSource?: number;
  /** 테스트에서 실제 API 호출을 대체하는 주입 지점. */
  /**
   * 테스트 주입. **객체를 주면 여기 있는 소스만 돈다** - 없는 소스는 건너뛴다(네트워크 차단).
   * 2026-09-18에 지식iN·카페·백과사전이 추가됐다(사용자가 API HUB에서 켬).
   */
  providers?: {
    news?: KeywordProvider;
    web?: KeywordProvider;
    blog?: KeywordProvider;
    kin?: KeywordProvider;
    cafe?: KeywordProvider;
    encyc?: KeywordProvider;
  };
};

export type CollectSourcesForJobResult = {
  sources: SourceInsert[];
  /** 실패한 검색 소스만 담는다("naver_news" -> 에러 메시지). 전부 성공하면 빈 객체. */
  sourceErrors: Partial<Record<KnownSearchSource, string>>;
};

/**
 * 2026-09-18: 지식iN·카페·백과사전 추가. 지식iN·카페 제목은 그 자체가 **독자의 질문 원문**이라
 * researcher.md §5와 기획 브리프의 재료가 되고(에이전트가 WebSearch로는 이 글들을 못 찾았다),
 * 백과사전은 "이게 뭔가"(Q1)의 근거다. 등급은 지식iN·카페=community, 백과=community(출처 불명 편집)로
 * classifySourceAuthority가 매긴다.
 */
const KNOWN_SEARCH_SOURCES = ["naver_news", "naver_web", "naver_blog", "naver_kin", "naver_cafe", "naver_encyc"] as const;
type KnownSearchSource = (typeof KNOWN_SEARCH_SOURCES)[number];

function isKnownSearchSource(value: string): value is KnownSearchSource {
  return (KNOWN_SEARCH_SOURCES as readonly string[]).includes(value);
}

/** RawKeyword(검색 결과 1건) -> SourceInsert. 출처 등급도 여기서 함께 판정한다. */
function toSourceInsert(jobId: string, raw: RawKeyword): SourceInsert | null {
  // source가 예상 밖 문자열이면(provider 오동작 등) 등급을 판정할 수 없으므로 건너뛴다 -
  // 잘못된 등급으로 저장하는 것보다 누락이 안전하다.
  if (!isKnownSearchSource(raw.source)) return null;

  const description = typeof raw.metadata?.description === "string" ? raw.metadata.description : null;

  return {
    job_id: jobId,
    title: raw.keyword || null,
    url: raw.sourceUrl ?? null,
    source_name: raw.source,
    published_at: raw.publishedAt ?? null,
    content: description,
    authority: classifySourceAuthority({ url: raw.sourceUrl, searchSource: raw.source }),
  };
}

/** url이 있는 것만, url 기준 중복을 제거하고 순서를 보존한다. */
function dedupeByUrl(items: SourceInsert[]): SourceInsert[] {
  const seen = new Set<string>();
  const result: SourceInsert[] = [];
  for (const item of items) {
    const key = item.url ?? `no-url:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export async function collectSourcesForJob(
  jobId: string,
  keyword: string,
  options: CollectSourcesForJobOptions = {}
): Promise<CollectSourcesForJobResult> {
  const displayPerSource = options.displayPerSource ?? 5;

  const injected = options.providers;
  const pick = (name: keyof NonNullable<typeof injected>, real: () => KeywordProvider): KeywordProvider | undefined =>
    injected ? injected[name] : real();

  const candidates: [KnownSearchSource, KeywordProvider | undefined][] = [
    ["naver_news", pick("news", () => new NaverNewsKeywordProvider({ queries: [keyword], displayPerQuery: displayPerSource }))],
    ["naver_web", pick("web", () => new NaverWebKeywordProvider({ queries: [keyword], displayPerQuery: displayPerSource }))],
    ["naver_blog", pick("blog", () => new NaverBlogKeywordProvider({ queries: [keyword], displayPerQuery: displayPerSource }))],
    ["naver_kin", pick("kin", () => new NaverSimpleSearchProvider({ kind: "kin", queries: [keyword], displayPerQuery: displayPerSource }))],
    ["naver_cafe", pick("cafe", () => new NaverSimpleSearchProvider({ kind: "cafearticle", queries: [keyword], displayPerQuery: displayPerSource }))],
    // 백과사전은 정의 하나면 충분하다.
    ["naver_encyc", pick("encyc", () => new NaverSimpleSearchProvider({ kind: "encyc", queries: [keyword], displayPerQuery: 2 }))],
  ];
  const jobs = candidates.filter((entry): entry is [KnownSearchSource, KeywordProvider] => entry[1] !== undefined);

  const sourceErrors: CollectSourcesForJobResult["sourceErrors"] = {};
  const collected: RawKeyword[] = [];

  for (const [name, provider] of jobs) {
    try {
      const results = await provider.fetchKeywords();
      collected.push(...results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors[name] = message;
      console.error(`⚠️ collectSourcesForJob: "${name}" 검색 실패 -`, message);
    }
  }

  if (Object.keys(sourceErrors).length === jobs.length) {
    // 셋 다 실패 - 이 job의 자료조사는 완전히 실패했다. 빈 결과를 반환하되 에러를 그대로 전달해
    // 호출자(runArticleJob)가 status를 되돌리지 않고 재시도 가능하게 남겨두도록 한다.
    return { sources: [], sourceErrors };
  }

  const mapped = collected
    .map((raw) => toSourceInsert(jobId, raw))
    .filter((item): item is SourceInsert => item !== null);

  return { sources: dedupeByUrl(mapped), sourceErrors };
}
