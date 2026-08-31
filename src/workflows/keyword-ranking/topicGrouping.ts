// Top N 선정 단계에서 "서로 다른 cluster지만 사실은 같은 주제"를 알아보기 위한 주제 동일성 판정.
//
// 왜 clustering만으로는 부족한가(2026-08-29 실측 재현):
// 같은 이슈("넷플릭스 들쥐")가 Top 10을 4칸 차지했다. 원인은 clustering 실패이고, 그 실패는 두 겹이다.
//
// 1) cross-seed 병합이 구조적으로 막혀 있다.
//    CLUSTERING_CONFIG.excludeSeedQueryFromTokens = true는 "seed 토큰은 그 seed에서 나온 거의 모든
//    후보에 공통으로 등장하므로 변별력이 없다"는 이유로 seed 토큰을 지운다. 같은 seed 안에서는 맞는
//    이야기지만, 서로 다른 seed에서 같은 이슈가 잡히면 정반대로 작동한다:
//      - seed "넷플릭스"에서 온 "넷플릭스 들쥐 출연진 총정리"  -> 토큰 {들쥐, 출연진}
//      - seed "들쥐"에서 온   "들쥐 결말 해석과 시즌2 가능성"  -> 토큰 {결말, 해석, 시즌2, 가능성}
//    두 제목이 공유하는 유일한 근거인 "들쥐"/"넷플릭스"가 각각 지워져 교집합이 정확히 0이 된다.
//    실측 pairwise 유사도가 combined=0.000(cross-seed threshold 0.55)이었다. 우연이 아니라 필연이다.
//    Creator Advisor가 화제 키워드를 매일 seed로 밀어 넣기 때문에("넷플릭스"는 seed_queries,
//    "들쥐"는 trend_candidates) 인기 이슈일수록 이 경로를 탄다.
//
// 2) 같은 seed 안에서도 뉴스 제목은 수식어가 많아 Jaccard가 threshold를 못 넘는다.
//    실측 combined 0.169~0.238 vs similarityThreshold 0.38.
//
// 그리고 selectDiverseTopN의 maxPerCanonicalTopic(=1)은 canonical keyword "문자열 완전 일치"로만
// 세기 때문에, 제목이 다르면 canonical도 달라져 cap이 아예 발화하지 않았다.
//
// 이 모듈의 역할: clustering 자체는 건드리지 않고(오병합 위험이 큰 영역이다), 최종 Top N 선정
// 단계에서만 "이미 뽑힌 것과 같은 주제인가"를 한 번 더 본다. clustering이 놓쳐도 Top 10 도배는 막힌다.
//
// 판정 신호 두 가지 (둘 중 하나라도 만족하면 같은 주제):
//   A. batch 안에서 희소한(distinctive) 핵심 명사를 하나 이상 공유한다.
//      "들쥐"는 400개 cluster 중 4개에만 나오므로 희소 -> 같은 주제의 강한 증거.
//      희소성 기준을 고정 상수가 아니라 batch 내 document frequency로 잡는 이유는, 어떤 단어가
//      "그날의 고유명사"인지는 그날 수집 결과가 알려주지 미리 적을 수 없기 때문이다.
//   B. 핵심 명사 집합이 충분히 겹친다(Jaccard >= threshold, 교집합 >= 2).
//      희소 토큰이 없어도 "부모급여 인상 시기"와 "부모급여 지급 시기"처럼 사실상 같은 건을 잡는다.
//
// 두 신호 모두에서 두 부류의 단어를 먼저 걷어낸다. 빼지 않으면 반대 방향 오류(과병합)가 난다:
//   - 범용 수식어(리뷰/후기/방법/이유/출연진/결말/촬영지...) -> genericTokens.
//     없으면 서로 다른 드라마 두 편이 "촬영지" 하나로 묶인다.
//   - 분류어(넷플릭스/티빙/드라마/영화/육아...) -> categoryTerms + extraCategoryTerms(seed_queries).
//     없으면 "넷플릭스 들쥐"와 "넷플릭스 오징어게임"이 플랫폼 이름 하나로 묶인다.
//     df 통계만으로는 이 둘을 구분할 수 없다: 후보가 얕은 날에는 "넷플릭스"의 df가 "들쥐"의 df와
//     거의 같아진다(실제로 이 테스트를 처음 돌렸을 때 그렇게 오병합됐다). 어떤 단어가 분류어인지는
//     통계가 아니라 이 프로젝트가 무엇을 상시 검색어로 등록해뒀는지가 알려주는 정보다.
//
// clustering과 달리 seed 토큰을 지우지 않는다(위 1번이 이 모듈을 만든 이유이므로).

import { TOPIC_GROUPING_CONFIG } from "../../config/keywordScoring.js";
import { extractCoreNouns, tokenize } from "./clustering/textNormalize.js";
import { intersectionSize, jaccardSimilarity } from "./clustering/similarity.js";

export type TopicIndex<T> = {
  /** 이 item이 가진 핵심 명사 전체(generic 제외 전). 디버그/진단용. */
  coreNounsOf(item: T): ReadonlySet<string>;
  /** 이 item이 가진 "batch 안에서 희소한" 핵심 명사. 같은 주제 판정 신호 A에 쓰인다. */
  distinctiveTokensOf(item: T): ReadonlySet<string>;
  /** 두 item이 같은 주제인지. 신호 A 또는 B를 만족하면 true. */
  isSameTopic(a: T, b: T): boolean;
  /** 이 batch에서 "희소"로 인정되는 document frequency 상한(진단/테스트용). */
  readonly distinctiveThreshold: number;
};

export type BuildTopicIndexOptions = {
  /**
   * 고정 목록(TOPIC_GROUPING_CONFIG.categoryTerms) 외에 이번 run에서만 분류어로 취급할 단어.
   * daily workflow는 seed_queries(사람이 등록한 상시 검색어)의 토큰을 여기로 넘긴다 - 상시 검색어는
   * 정의상 "그날의 주제"가 아니라 분류이기 때문이다. Creator Advisor에서 온 그날의 화제 키워드는
   * 넘기지 않는다(그건 주제 그 자체다).
   */
  extraCategoryTerms?: readonly string[];
  /** batch 크기 대비 희소 판정 비율. 기본 TOPIC_GROUPING_CONFIG.distinctiveDocFrequencyRatio. */
  distinctiveDocFrequencyRatio?: number;
  /** 희소 판정 df 하한(batch가 아주 작을 때 비율만으로는 0이 되는 것을 막는다). */
  minDistinctiveDocFrequency?: number;
  /** 희소 판정 df 상한(batch가 아주 클 때 흔한 단어까지 희소로 인정되는 것을 막는다). */
  maxDistinctiveDocFrequency?: number;
  /** 신호 B의 핵심 명사 Jaccard 임계값. */
  coreNounSameTopicThreshold?: number;
  /** 신호 B가 요구하는 최소 교집합 개수. */
  coreNounSameTopicMinIntersection?: number;
};

const BASE_EXCLUDED_TOKENS = new Set(
  [...TOPIC_GROUPING_CONFIG.genericTokens, ...TOPIC_GROUPING_CONFIG.categoryTerms].map((token) =>
    token.toLowerCase()
  )
);

/**
 * 분류어/범용 수식어 목록을 만든다. 주어진 extraCategoryTerms는 문장일 수 있으므로(예: seed query
 * "신작 드라마") 토큰 단위로 쪼개서 넣는다.
 */
function buildExcludedTokens(extraCategoryTerms: readonly string[] = []): Set<string> {
  const excluded = new Set(BASE_EXCLUDED_TOKENS);
  for (const term of extraCategoryTerms) {
    for (const token of tokenize(term)) excluded.add(token.toLowerCase());
    excluded.add(term.trim().toLowerCase());
  }
  return excluded;
}

/**
 * 주제 판정에 쓸 핵심 명사 집합을 만든다. clustering과 달리 seedQuery 토큰을 제외하지 않는다 -
 * cross-seed 상황에서 seed 토큰이야말로 같은 주제라는 유일한 증거인 경우가 많기 때문이다(파일 상단 주석).
 * 대신 분류어/범용 수식어만 걷어낸다.
 */
export function buildTopicTokens(
  text: string,
  excludedTokens: ReadonlySet<string> = BASE_EXCLUDED_TOKENS
): Set<string> {
  const coreNouns = extractCoreNouns(tokenize(text));
  return new Set(coreNouns.filter((token) => !excludedTokens.has(token.toLowerCase())));
}

/** token -> 그 token을 포함한 item 개수. */
export function computeTokenDocumentFrequency(tokenSets: readonly ReadonlySet<string>[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return documentFrequency;
}

/**
 * batch 크기에 따라 "희소"로 인정할 document frequency 상한을 정한다.
 * 고정 상수를 쓰지 않는 이유: 후보가 얕은 날(수십 개)과 평소(수백 개)의 df 분포가 크게 다르다.
 */
export function resolveDistinctiveThreshold(batchSize: number, options: BuildTopicIndexOptions = {}): number {
  const ratio = options.distinctiveDocFrequencyRatio ?? TOPIC_GROUPING_CONFIG.distinctiveDocFrequencyRatio;
  const min = options.minDistinctiveDocFrequency ?? TOPIC_GROUPING_CONFIG.minDistinctiveDocFrequency;
  const max = options.maxDistinctiveDocFrequency ?? TOPIC_GROUPING_CONFIG.maxDistinctiveDocFrequency;

  return Math.min(max, Math.max(min, Math.ceil(batchSize * ratio)));
}

/**
 * batch 전체를 훑어 df를 한 번 계산해두고, 그 위에서 두 item의 주제 동일성을 판정하는 index를 만든다.
 * df는 batch 전체(top N으로 자르기 전) 기준으로 계산해야 희소성 판단이 의미를 갖는다.
 */
export function buildTopicIndex<T>(
  items: readonly T[],
  readText: (item: T) => string,
  options: BuildTopicIndexOptions = {}
): TopicIndex<T> {
  const excludedTokens = buildExcludedTokens(options.extraCategoryTerms);

  const coreNounsByItem = new Map<T, Set<string>>();
  for (const item of items) {
    coreNounsByItem.set(item, buildTopicTokens(readText(item), excludedTokens));
  }

  const documentFrequency = computeTokenDocumentFrequency([...coreNounsByItem.values()]);
  const distinctiveThreshold = resolveDistinctiveThreshold(items.length, options);

  const distinctiveByItem = new Map<T, Set<string>>();
  for (const [item, coreNouns] of coreNounsByItem) {
    const distinctive = new Set<string>();
    for (const token of coreNouns) {
      if ((documentFrequency.get(token) ?? 0) <= distinctiveThreshold) distinctive.add(token);
    }
    distinctiveByItem.set(item, distinctive);
  }

  const coreNounThreshold =
    options.coreNounSameTopicThreshold ?? TOPIC_GROUPING_CONFIG.coreNounSameTopicThreshold;
  const coreNounMinIntersection =
    options.coreNounSameTopicMinIntersection ?? TOPIC_GROUPING_CONFIG.coreNounSameTopicMinIntersection;

  // index에 없는 item(호출자가 나중에 만든 것)도 안전하게 처리한다 - 그때만 즉석에서 토큰을 만든다.
  const coreNounsOf = (item: T): Set<string> => {
    const cached = coreNounsByItem.get(item);
    if (cached) return cached;
    const computed = buildTopicTokens(readText(item), excludedTokens);
    coreNounsByItem.set(item, computed);
    return computed;
  };

  const distinctiveTokensOf = (item: T): Set<string> => {
    const cached = distinctiveByItem.get(item);
    if (cached) return cached;

    const distinctive = new Set<string>();
    for (const token of coreNounsOf(item)) {
      if ((documentFrequency.get(token) ?? 0) <= distinctiveThreshold) distinctive.add(token);
    }
    distinctiveByItem.set(item, distinctive);
    return distinctive;
  };

  return {
    coreNounsOf,
    distinctiveTokensOf,
    distinctiveThreshold,
    isSameTopic(a: T, b: T): boolean {
      if (a === b) return true;

      // 신호 A: batch 안에서 희소한 핵심 명사를 공유한다.
      if (intersectionSize(distinctiveTokensOf(a), distinctiveTokensOf(b)) >= 1) return true;

      // 신호 B: 핵심 명사 집합 자체가 충분히 겹친다.
      const coreA = coreNounsOf(a);
      const coreB = coreNounsOf(b);
      return (
        jaccardSimilarity(coreA, coreB) >= coreNounThreshold &&
        intersectionSize(coreA, coreB) >= coreNounMinIntersection
      );
    },
  };
}
