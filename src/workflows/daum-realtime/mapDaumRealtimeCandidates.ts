// 다음 실시간 트렌드 항목 -> trend_candidates insert row 변환(순수 함수).
// mapGoogleTrendsCandidates.ts와 같은 층위이며, DB 접근은 하지 않는다.
//
// Google Trends와 같은 이유로 topic이 없다 - 다음도 분야 구분 없이 순위 목록 하나만 준다. category는
// 키워드 어휘(classifyKeywordCategory)로 우선 판정하고, 못 잡으면 "living"으로 폴백한다(구글 트렌드와
// 동일한 규약 - 기존 4종 밖의 값을 새로 만들지 않는다). 뉴스 출처 신호(newsOutletRules.ts)는 다음
// 실시간 트렌드 데이터에 출처 정보가 없어 적용할 수 없다.
//
// movement_type은 다음이 준 status를 그대로 옮긴다: "new"->new, "0"->flat, 그 외 숫자 문자열은
// 부호로 up/down을 정한다(공식 문서상 이 값은 "노출 순위 변동"이 아니라 "모델링 점수 추이"라 다소
// 노이즈가 있을 수 있다 - 그래도 정보 없음보다는 낫다).

import { TREND_SOURCE_CONFIGS, isUsableTrendKeyword } from "../../config/trendSources.js";
import { classifyKeywordCategory } from "../../config/keywordCategoryRules.js";
import type { DaumRealtimeItem } from "../../services/search/providers/daumRealtime/parseDaumRealtimePage.js";
import type { TrendCandidateInsert, TrendCandidateMovementType } from "../../types/database.js";

export const DAUM_REALTIME_SOURCE = "daum_realtime";
/** trend_candidates.topic에 저장할 고정값. 다음은 분야를 주지 않는다(파일 상단 주석). */
export const DAUM_REALTIME_TOPIC = "daum_realtime";
/** 어휘 신호가 전혀 없을 때의 category. Google Trends와 동일한 폴백. */
const FALLBACK_CATEGORY = "living";

/** displayRank 1이 이 값을 받고 순위가 내려갈수록 선형 감소한다(다른 소스의 rank 점수 스케일과 유사). */
const RANK_SCORE_MAX = 30;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveDaumRealtimeCategory(keyword: string): string {
  return classifyKeywordCategory(keyword) ?? FALLBACK_CATEGORY;
}

export function computeDaumRealtimeCandidateScore(displayRank: number): number {
  return Math.max(0, Math.round(RANK_SCORE_MAX - (displayRank - 1) * (RANK_SCORE_MAX / 10)));
}

/** "new"/"0"/부호 있는 숫자 문자열 -> TrendCandidateMovementType. 해석 불가 값은 flat으로 안전 처리. */
export function resolveDaumRealtimeMovement(status: string): TrendCandidateMovementType {
  if (status === "new") return "new";
  const value = Number(status);
  if (Number.isNaN(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

export type MapDaumRealtimeOptions = {
  /** 수집 시각 ISO. trend_date와 expires_at의 기준. */
  collectedAt: string;
  /** expires_at = collectedAt + ttlHours. 생략하면 config 값. */
  ttlHours?: number;
};

export function mapDaumRealtimeItemToInsert(
  item: DaumRealtimeItem,
  options: MapDaumRealtimeOptions
): TrendCandidateInsert {
  const ttlHours = options.ttlHours ?? TREND_SOURCE_CONFIGS.daum_realtime.candidateTtlHours;
  const collectedAtMs = new Date(options.collectedAt).getTime();
  const expiresAt = new Date(collectedAtMs + ttlHours * 60 * 60 * 1000).toISOString();
  const movement = resolveDaumRealtimeMovement(item.status);

  return {
    keyword: item.keyword,
    keyword_normalized: normalize(item.keyword),
    topic: DAUM_REALTIME_TOPIC,
    topic_normalized: resolveDaumRealtimeCategory(item.keyword),
    source: DAUM_REALTIME_SOURCE,
    trend_date: options.collectedAt.slice(0, 10),
    rank: item.displayRank,
    movement_type: movement,
    rank_change: null,
    candidate_score: computeDaumRealtimeCandidateScore(item.displayRank),
    collected_at: options.collectedAt,
    expires_at: expiresAt,
    status: "active",
    metadata: {
      internalRank: item.rank,
      rawStatus: item.status,
      dataType: item.dataType ?? null,
    },
  };
}

/**
 * 같은 규약(mapGoogleTrendsCandidates.ts 참고)으로 두 가지를 버린다: 중복 키워드(같은 배치 안에서
 * unique index conflict key가 겹치면 upsert 전체가 21000으로 거부된다)와 너무 짧은 키워드
 * (relevance 필터를 무력화한다 - config/trendSources.ts 주석).
 */
export function mapDaumRealtimeItemsToInserts(
  items: readonly DaumRealtimeItem[],
  options: MapDaumRealtimeOptions
): { rows: TrendCandidateInsert[]; droppedCount: number; droppedKeywords: string[] } {
  const rows: TrendCandidateInsert[] = [];
  const seen = new Set<string>();
  const droppedKeywords: string[] = [];

  for (const item of items) {
    const key = normalize(item.keyword);
    if (seen.has(key) || !isUsableTrendKeyword(item.keyword)) {
      droppedKeywords.push(item.keyword);
      continue;
    }
    seen.add(key);
    rows.push(mapDaumRealtimeItemToInsert(item, options));
  }

  return { rows, droppedCount: droppedKeywords.length, droppedKeywords };
}
