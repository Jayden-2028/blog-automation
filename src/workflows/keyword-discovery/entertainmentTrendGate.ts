// 엔터 트랙 "전 분야 트렌드" 게이트 (KEYWORD-ENT-PURITY-2026-10.md A-3).
// 근거·설계 원칙·strict/loose의 차이는 config/entertainmentTrendGate.ts 상단에 있다.
//
// 대상은 **동적 소스(creator_advisor/google_trends/daum_realtime/community) 유래 시드로 찾아온
// 후보뿐**이다. seed_queries는 사람이 큐레이션한 상시 검색어라 이 게이트를 통과시키지 않는다 -
// 거기서 나오는 오염은 시드 자체를 고치는 쪽이 옳고(10/16 `스틸` -> `공식 스틸`), 게이트로 덮으면
// 나쁜 시드가 영원히 남는다.
//
// 외부 호출 없는 순수 함수다. 판정만 하고 아무것도 저장하지 않는다 - 적용 여부는 호출자가 정한다.

import { ENT_TREND_GATE_CONFIG } from "../../config/entertainmentTrendGate.js";
import { classifyKeywordCategory } from "../../config/keywordCategoryRules.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

export type EntTrendGateVerdict = {
  keyword: string;
  seedQuery: string | null;
  /** 통과 신호. 하나라도 true면 엔터로 본다. */
  signals: { role: boolean; category: boolean; media: boolean };
  /** classifyKeywordCategory 결과. strict 판정의 "비엔터 확정" 근거다. */
  classified: string | null;
};

export type EntTrendGateResult = {
  /** 게이트가 실제로 들여다본 후보 수(동적 소스 유래만). */
  evaluated: number;
  /** 엔터 신호가 없고 **비엔터 카테고리가 확정된** 후보. apply를 켜면 이쪽만 버린다. */
  strictDrops: EntTrendGateVerdict[];
  /** 엔터 신호가 없는 후보 전부(strictDrops 포함). 더 센 기준을 쓰면 얼마나 더 빠지는지 본다. */
  looseDrops: EntTrendGateVerdict[];
  /** apply 여부를 반영한 결과 후보 목록. apply=false면 입력과 동일하다. */
  candidates: KeywordCandidate[];
  applied: boolean;
};

function hasTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export type EvaluateEntTrendGateOptions = {
  /** 동적 소스 유래 시드 검색어 목록. 이 시드로 찾아온 후보만 판정한다. */
  trendQueries: readonly string[];
  /** 테스트에서 config를 덮어쓰기 위한 주입 지점. */
  config?: typeof ENT_TREND_GATE_CONFIG;
};

export function evaluateEntertainmentTrendGate(
  candidates: readonly KeywordCandidate[],
  options: EvaluateEntTrendGateOptions
): EntTrendGateResult {
  const config = options.config ?? ENT_TREND_GATE_CONFIG;
  const trendQuerySet = new Set(options.trendQueries.map((q) => q.trim().toLowerCase()));

  const strictDrops: EntTrendGateVerdict[] = [];
  const looseDrops: EntTrendGateVerdict[] = [];
  const strictDropKeys = new Set<KeywordCandidate>();
  let evaluated = 0;

  for (const candidate of candidates) {
    const seedQuery = typeof candidate.metadata?.query === "string" ? candidate.metadata.query : null;
    if (!seedQuery || !trendQuerySet.has(seedQuery.trim().toLowerCase())) continue;
    evaluated++;

    // 제목과 시드를 함께 본다. 시드가 "배우 김현이 별세"처럼 역할어를 들고 오는 경우가 있다.
    const text = `${candidate.keyword} ${seedQuery}`.toLowerCase();
    const classified = classifyKeywordCategory(candidate.keyword);

    const signals = {
      role: hasTerm(text, config.roleTerms),
      category: classified === "entertainment" || classified === "ott",
      media: hasTerm(text, config.mediaTerms),
    };
    if (signals.role || signals.category || signals.media) continue;

    const verdict: EntTrendGateVerdict = { keyword: candidate.keyword, seedQuery, signals, classified };
    looseDrops.push(verdict);
    if (classified !== null && config.nonEntCategories.includes(classified)) {
      strictDrops.push(verdict);
      strictDropKeys.add(candidate);
    }
  }

  const applied = config.apply && strictDropKeys.size > 0;
  return {
    evaluated,
    strictDrops,
    looseDrops,
    candidates: applied ? candidates.filter((c) => !strictDropKeys.has(c)) : [...candidates],
    applied: config.apply,
  };
}
