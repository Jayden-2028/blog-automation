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

// ---------- 수집 입구 날짜 컷 (2026-10-21, KEYWORD-HEADLINE-FRESHNESS-2026-10.md ①) ----------
//
// 왜: run 182 Top 10에 연 단위로 낡은 제목이 올라왔다. [5] "넷플릭스 See What's Next Korea 2021"은
// 정적 시드 "넷플릭스 공개 예정" 검색의 2021년 문서였고, [7] "나의 유죄인간 캐스팅 확정"은 이미
// 10/19 첫방인 작품의 9/24 기사였다. 검색은 sort=date지만 **기간 제한이 없어서** 그 시드로 나올
// 문서가 적으면 몇 년 전 문서가 그대로 상위 10건에 들어온다.
//
// 날짜가 **없는** 결과는 버리지 않는다. 웹문서는 애초에 날짜가 없고, 뉴스·블로그도 파싱이 실패할 수
// 있다. "날짜를 모른다"를 "낡았다"로 취급하면 커버리지가 상한다 - 무날짜의 격하는 헤드라인 소스
// 우선순위(②, clusterAttribution)가 맡는다.
export const NAVER_CANDIDATE_MAX_AGE_DAYS_ENV = "NAVER_CANDIDATE_MAX_AGE_DAYS";

/** 날짜 컷 기본값(일). 0 또는 음수면 컷 자체가 꺼진다(롤백 스위치). */
export const DEFAULT_CANDIDATE_MAX_AGE_DAYS = 7;

/** 날짜 컷을 적용할 소스. 웹문서(naver_web)는 날짜가 없어 대상이 아니다. */
const AGE_CUT_SOURCES = ["naver_news", "naver_blog"] as const;
type AgeCutSource = (typeof AGE_CUT_SOURCES)[number];

export type CandidateAgeCut = {
  /** 적용된 상한(일). 0 이하면 컷이 꺼진 상태다. */
  maxAgeDays: number;
  /** 소스별로 몇 건을 버렸는지. 컷이 꺼져 있으면 전부 0이다. */
  droppedBySource: Record<AgeCutSource, number>;
};

/**
 * NAVER_CANDIDATE_MAX_AGE_DAYS 해석. 미설정·빈 값·숫자 아님이면 기본 7일이고,
 * 0 또는 음수는 "컷 비활성"으로 그대로 통과시킨다.
 */
export function parseCandidateMaxAgeDays(
  value: string | undefined,
  fallback: number = DEFAULT_CANDIDATE_MAX_AGE_DAYS
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAgeCutSource(source: string): source is AgeCutSource {
  return (AGE_CUT_SOURCES as readonly string[]).includes(source);
}

/**
 * 뉴스·블로그 결과 중 publishedAt이 상한을 넘은 문서를 버린다. 순수 함수다(테스트는 now를 고정한다).
 *
 * 버리지 않는 경우: ① 컷이 꺼져 있다(maxAgeDays <= 0) ② 대상 소스가 아니다(웹문서)
 * ③ publishedAt이 없거나 파싱되지 않는다 ④ 미래 날짜(시차·오기재를 낡음으로 보지 않는다).
 */
export function dropStaleRawKeywords(
  rawKeywords: readonly RawKeyword[],
  options: { maxAgeDays: number; now?: Date } = { maxAgeDays: DEFAULT_CANDIDATE_MAX_AGE_DAYS }
): { kept: RawKeyword[]; ageCut: CandidateAgeCut } {
  const droppedBySource: Record<AgeCutSource, number> = { naver_news: 0, naver_blog: 0 };
  const maxAgeDays = options.maxAgeDays;
  const ageCut: CandidateAgeCut = { maxAgeDays, droppedBySource };

  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    return { kept: [...rawKeywords], ageCut };
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const kept = rawKeywords.filter((item) => {
    if (!isAgeCutSource(item.source)) return true;
    if (!item.publishedAt) return true;

    const publishedMs = new Date(item.publishedAt).getTime();
    if (Number.isNaN(publishedMs)) return true;

    const ageMs = nowMs - publishedMs;
    if (ageMs <= maxAgeMs) return true;

    droppedBySource[item.source] += 1;
    return false;
  });

  return { kept, ageCut };
}

export type CollectNaverCandidatesOptions = {
  /** query당 API별로 가져올 결과 개수. 기본 10. 실제 API 테스트 시에는 소량(5 정도)을 권장. */
  displayPerQuery?: number;
  /** query 간 순차 호출 사이에 둘 지연 시간(ms). rate limit 보호용. 기본 150ms. */
  requestDelayMs?: number;
  categoryByQuery?: Record<string, string>;
  /**
   * 날짜 컷 상한(일)을 명시적으로 덮어쓴다. 생략하면 env NAVER_CANDIDATE_MAX_AGE_DAYS(기본 7)를 쓴다.
   * 0 이하면 컷을 끈다.
   */
  maxAgeDays?: number;
  /** 날짜 컷 기준 시각. 테스트에서만 고정한다. */
  now?: Date;
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
  /**
   * 날짜 컷 결과. dailyKeywordWorkflow가 discovery_runs.metadata.candidateAgeCut으로 저장한다 -
   * 컷은 relevance·clustering 이전에 일어나므로 랭킹 로그만 봐서는 얼마나 걸렀는지 셀 수 없다.
   */
  ageCut: CandidateAgeCut;
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

  // 날짜 컷은 provider 결과를 하나로 합친 **이 한 곳**에서만 돈다. provider마다 넣으면 새 provider가
  // 추가될 때 조용히 빠진다. countsByQuery는 **컷 이전** 숫자를 그대로 쓴다 - 그 값은 6-factor
  // scoring의 활동량 신호(newsVelocity 등) 입력이고, 이번 발주의 금지 경계가 scoring 비접촉이다.
  // "검색에서 몇 건 나왔나"와 "그중 몇 건을 후보로 쓰나"는 다른 질문이라 섞지 않는다.
  const { kept: rawKeywords, ageCut } = dropStaleRawKeywords(
    [...keywordsBySource.naver_news, ...keywordsBySource.naver_blog, ...keywordsBySource.naver_web],
    {
      maxAgeDays:
        options.maxAgeDays ?? parseCandidateMaxAgeDays(process.env[NAVER_CANDIDATE_MAX_AGE_DAYS_ENV]),
      now: options.now,
    }
  );

  const droppedTotal = ageCut.droppedBySource.naver_news + ageCut.droppedBySource.naver_blog;
  if (droppedTotal > 0) {
    console.log(
      `ℹ️ [collectNaverCandidates] ${ageCut.maxAgeDays}일 초과 문서 ${droppedTotal}건 제외 ` +
        `(뉴스 ${ageCut.droppedBySource.naver_news} · 블로그 ${ageCut.droppedBySource.naver_blog})`
    );
  }

  const normalizedKeywords = normalizeKeywords(rawKeywords);
  const { candidates, duplicateCount } = deduplicateKeywords(normalizedKeywords);

  return {
    rawKeywords,
    normalizedKeywords,
    candidates,
    duplicateInBatch: duplicateCount,
    countsByQuery,
    sourceErrors,
    ageCut,
  };
}
