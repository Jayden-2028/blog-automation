// scoreBreakdown을 사람이 읽을 수 있는 한 줄 reason으로 변환한다.
// 예: "검색 관심 상승 + 뉴스 12건 + 3개 소스 동시 언급"

import { KEYWORD_SCORE_WEIGHTS } from "../../config/keywordScoring.js";
import type { KeywordScoreBreakdown, KeywordScoreInput } from "../../types/keywordScoring.js";

const TREND_DIRECTION_LABEL: Record<KeywordScoreInput["trendDirection"], string> = {
  rising: "검색 관심 상승",
  accelerating: "검색 관심 급상승",
  falling: "검색 관심 하락",
  flat: "검색 관심 보합",
  unknown: "검색 트렌드 데이터 없음",
};

export function buildReason(input: KeywordScoreInput, breakdown: KeywordScoreBreakdown): string {
  const parts: string[] = [];

  if (input.trendDirection !== "unknown") {
    parts.push(TREND_DIRECTION_LABEL[input.trendDirection]);
  }

  if (input.newsCount > 0) {
    parts.push(`뉴스 ${input.newsCount}건`);
  }

  if (input.sources.length >= 2) {
    parts.push(`${input.sources.length}개 소스 동시 언급`);
  }

  if (breakdown.clickPotential > 0) {
    parts.push("클릭 유도 표현 포함");
  }

  const isVeryFresh = breakdown.freshness >= KEYWORD_SCORE_WEIGHTS.freshness * 0.7;
  if (isVeryFresh && parts.length < 2) {
    parts.push("최신 콘텐츠 다수");
  }

  const base = parts.length > 0 ? parts.join(" + ") : "특이 신호 없음";
  return input.seedQuerySelectionNote ? `${base} (${input.seedQuerySelectionNote})` : base;
}
