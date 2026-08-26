// candidate(뉴스/블로그/웹문서 검색 결과 1건)가 원래 seed 검색어와 실제로 관련이 있는지를
// 0~1 relevance score로 계산한다. 형태소 분석기/LLM 없이, seed query 토큰이 candidate의
// title(keyword)/description에 실제로 등장하는지를 기준으로 하는 규칙 기반 근사치다.
//
// 배경: seed로 "쿠팡플레이"를 검색해도 Naver 검색 특성상 "쿠팡플레이"와 직접 관련 없는 결과
// (예: 스폰서십 기사에 "쿠팡" 언급만 있는 경우 등)가 섞여 들어올 수 있다. clustering/scoring
// 단계로 넘어가기 전에 이런 후보를 걸러내거나 감점해 Top10 품질을 높인다.

import { SEED_QUERY_ALIASES, SEED_RELEVANCE_CONFIG } from "../../config/keywordScoring.js";
import { normalizeTitle, tokenize } from "../keyword-ranking/clustering/textNormalize.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function extractSeedQuery(candidate: KeywordCandidate): string | undefined {
  const query = candidate.metadata.query;
  return typeof query === "string" && query.trim() ? query : undefined;
}

function extractDescription(candidate: KeywordCandidate): string {
  const description = candidate.metadata.description;
  return typeof description === "string" ? description : "";
}

// 하나의 phrase(seedQuery 원문 또는 alias 하나)를 기준으로 candidate(title/description)와의
// 관련성을 0~1로 계산한다. null을 반환하면 이 phrase는 평가 불가(토큰이 0개 등)를 의미한다.
//
// - phrase가 title에 구(phrase) 단위로 그대로 등장하면 exactPhraseMatchScore(기본 1)로 확정한다.
//   공백 없는 고유 브랜드/서비스명(쿠팡플레이 등)은 토큰이 1개뿐이라 "토큰 일치 = phrase 일치"가
//   거의 같으므로, 이 규칙이 곧 "브랜드명 등장을 강하게 신뢰"하는 효과를 낸다.
// - 그 외에는 seed 토큰 중 title/description에 실제로 등장하는 비율(overlapRatio)을 구하고,
//   partialOverlapPenaltyExponent로 제곱해 "토큰 일부만 겹침"을 비선형으로 감점한다. 예를 들어
//   seedQuery="신작 드라마"인데 title에 "드라마"만 있으면(overlapRatio=0.5) 선형 합산 때보다 훨씬
//   낮은 값이 되어, "쿠팡 회원 탈퇴"처럼 seed 토큰 중 하나만 스치듯 겹치는 후보가 threshold를
//   쉽게 넘지 못하게 한다.
function computeRelevanceForPhrase(
  phrase: string,
  titleTokens: Set<string>,
  descriptionTokens: Set<string>,
  titleNorm: string
): number | null {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0) return null;

  const phraseNorm = normalizeTitle(phrase);
  const exactPhraseMatch = phraseNorm.length > 0 && titleNorm.includes(phraseNorm);
  if (exactPhraseMatch) return SEED_RELEVANCE_CONFIG.exactPhraseMatchScore;

  const titleOverlapRatio =
    phraseTokens.filter((token) => titleTokens.has(token)).length / phraseTokens.length;
  const descriptionOverlapRatio =
    descriptionTokens.size > 0
      ? phraseTokens.filter((token) => descriptionTokens.has(token)).length / phraseTokens.length
      : 0;

  const exponent = SEED_RELEVANCE_CONFIG.partialOverlapPenaltyExponent;
  const penalizedTitleOverlap = titleOverlapRatio ** exponent;
  const penalizedDescriptionOverlap = descriptionOverlapRatio ** exponent;

  const raw =
    penalizedTitleOverlap * SEED_RELEVANCE_CONFIG.titleTokenWeight +
    penalizedDescriptionOverlap * SEED_RELEVANCE_CONFIG.descriptionTokenWeight;

  return clamp01(raw);
}

// seed query <-> candidate(title + description) 관련성을 0~1로 계산한다.
// seedQuery 원문과 SEED_QUERY_ALIASES에 등록된 alias(동의어/영문 표기 등)를 모두 평가해 그중
// 최댓값을 사용한다 — candidate가 seed의 어떤 표기로든 명확히 관련 있으면 놓치지 않기 위함.
export function computeSeedRelevance(candidate: KeywordCandidate): number {
  const seedQuery = extractSeedQuery(candidate);
  // seed 정보가 없는 candidate(예: query metadata가 없는 경우)는 relevance를 판단할 근거가 없으므로
  // 걸러내지 않고 만점을 준다 — "정보 없음"을 "무관함"으로 오판하지 않기 위함.
  if (!seedQuery) return 1;

  const titleTokens = new Set(tokenize(candidate.keyword));
  const description = extractDescription(candidate);
  const descriptionTokens = description ? new Set(tokenize(description)) : new Set<string>();
  const titleNorm = normalizeTitle(candidate.keyword);

  const phrases = [seedQuery, ...(SEED_QUERY_ALIASES[seedQuery] ?? [])];

  let best: number | null = null;
  for (const phrase of phrases) {
    const score = computeRelevanceForPhrase(phrase, titleTokens, descriptionTokens, titleNorm);
    if (score === null) continue;
    if (best === null || score > best) best = score;
  }

  // 모든 phrase가 평가 불가(토큰 0개)면 seed 자체가 너무 짧아 판단 근거가 없는 것으로 보고 중립 점수를 준다.
  return best ?? SEED_RELEVANCE_CONFIG.neutralRelevanceWhenSeedTooShort;
}

export type ScoredCandidate = {
  candidate: KeywordCandidate;
  relevance: number;
};

export type FilterCandidatesByRelevanceResult = {
  candidates: KeywordCandidate[];
  scored: ScoredCandidate[];
  totalBefore: number;
  totalAfter: number;
  droppedCount: number;
};

// relevance가 threshold 미만인 candidate를 제거한다. threshold는 SEED_RELEVANCE_CONFIG에서 조절한다.
export function filterCandidatesByRelevance(
  candidates: KeywordCandidate[]
): FilterCandidatesByRelevanceResult {
  const scored = candidates.map((candidate) => ({
    candidate,
    relevance: computeSeedRelevance(candidate),
  }));

  const kept = scored.filter(
    (item) => item.relevance >= SEED_RELEVANCE_CONFIG.minRelevanceThreshold
  );

  return {
    // attribution 단계가 대표 seed/headline을 고를 때 실제 relevance를 사용할 수 있도록
    // 통과한 candidate에 계산값을 함께 전달한다. DB schema나 6-factor scoring 입력은 바꾸지 않는다.
    candidates: kept.map((item) => ({
      ...item.candidate,
      metadata: {
        ...item.candidate.metadata,
        relevanceScore: item.relevance,
      },
    })),
    scored,
    totalBefore: candidates.length,
    totalAfter: kept.length,
    droppedCount: candidates.length - kept.length,
  };
}
