// 구글 트렌드 RSS 항목 -> trend_candidates insert row 변환(순수 함수).
// mapCreatorAdvisorCandidates.ts와 같은 층위이며, DB 접근은 하지 않는다.
//
// Creator Advisor와 다른 점 세 가지:
//
// 1) topic이 없다. 구글 트렌드는 분야 구분 없이 순위 목록 하나만 준다. 그래서 topic에는 고정값
//    "google_trends"를 넣고(원문 보존 필드이므로 거짓 분야명을 지어내지 않는다), category는
//    아래 3단계로 정한다.
//
//    첫 실측(2026-08-29 KR TOP 10)에서 **10건 중 9건이 키워드 어휘 규칙에 걸리지 않았다** -
//    급상승 검색어의 상당수가 인명·고유명사이기 때문이다. 폴백할 topic 매핑도 없어 유재석/오연수/
//    엄태웅이 전부 living("생활정보")이 됐다. category는 원고 톤과 Top 10 backfill을 결정하므로
//    실제로 엉뚱한 톤의 원고를 만드는 오분류다.
//
//    실마리는 피드가 topic 대신 주는 **뉴스 항목의 출처**였다. 스포츠지/연예매체에 실렸다는 사실이
//    곧 연예 뉴스라는 강한 신호다(newsOutletRules.ts). 판정 순서:
//      a. 키워드 어휘 (classifyKeywordCategory)      - 가장 직접적인 신호
//      b. 뉴스 출처   (classifyCategoryByNewsOutlets) - 인명을 잡는 유일한 실마리
//      c. "living" 폴백                               - 미분류용 새 값을 만들지 않는다
//    a가 b보다 먼저인 것이 중요하다. 그래야 "아기 수족구"가 스포츠지에 실려도 parenting을 유지한다.
//    실측 결과 b는 연예인 3건을 정확히 잡고 나머지 7건은 건드리지 않았다(오탐 0).
//
// 2) movement_type을 알 수 없다. 피드는 "지금 급상승"만 주고 어제 대비 순위 변화를 주지 않는다.
//    전부 "new"로 두는 것은 거짓이므로("어제도 1위였던 키워드"를 new라고 하게 된다) "flat"을 쓴다 -
//    스키마가 허용하는 네 값 중 "변화 정보 없음"에 가장 가까운 중립값이다. rank_change는 null.
//
// 3) candidate_score를 순위와 검색량으로 만든다. Creator Advisor는 rank + movement로 계산하는데
//    (scoreCreatorAdvisorCandidate.ts) 여기엔 movement가 없다. 대신 피드가 approx_traffic을 준다.

import { MIN_TREND_KEYWORD_LENGTH, TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { classifyKeywordCategory } from "../../config/keywordCategoryRules.js";
import { classifyCategoryByNewsOutlets } from "../../config/newsOutletRules.js";
import type { GoogleTrendsItem } from "../../services/search/providers/googleTrends/parseGoogleTrendsRss.js";
import type { TrendCandidateInsert } from "../../types/database.js";

export const GOOGLE_TRENDS_SOURCE = "google_trends";
/** trend_candidates.topic에 저장할 고정값. 구글 트렌드는 분야를 주지 않는다(파일 상단 주석). */
export const GOOGLE_TRENDS_TOPIC = "google_trends";
/** 어휘 신호가 전혀 없을 때의 category. 기존 4종 밖의 값을 새로 만들지 않는다. */
const FALLBACK_CATEGORY = "living";

/** 순위 점수의 만점. rank 1이 이 값을 받고 순위가 내려갈수록 선형 감소한다. */
const RANK_SCORE_MAX = 30;
/** 검색량 점수의 만점. */
const TRAFFIC_SCORE_MAX = 20;
/** 이 검색량 이상이면 검색량 점수 만점. 피드의 상위 항목이 보통 이 규모다. */
const TRAFFIC_FULL_SCORE_THRESHOLD = 50_000;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 키워드 어휘 -> 뉴스 출처 -> living 순으로 category를 정한다(파일 상단 주석의 3단계).
 * 순서가 곧 신뢰도 순이며, 앞 단계가 확실한 신호를 주면 뒤는 보지 않는다.
 */
export function resolveGoogleTrendsCategory(item: GoogleTrendsItem): string {
  return (
    classifyKeywordCategory(item.keyword) ??
    classifyCategoryByNewsOutlets(item.newsItems.map((news) => news.source)) ??
    FALLBACK_CATEGORY
  );
}

/**
 * 이 키워드를 daily pool에 넣어도 되는지. 지금은 최소 길이 하나만 본다.
 * 1글자 키워드는 relevance 게이트를 무력화하므로 반드시 걸러야 한다(MIN_TREND_KEYWORD_LENGTH 주석).
 */
export function isUsableTrendKeyword(keyword: string): boolean {
  return keyword.replace(/\s+/g, "").length >= MIN_TREND_KEYWORD_LENGTH;
}

/**
 * rank(1부터) + approx_traffic -> 0~50 점수.
 * Creator Advisor 점수(rank + movement 기반)와 스케일을 맞출 필요는 없다 - candidate_score는
 * **같은 source 안에서만** 비교된다(buildDailyQueryPool이 소스별 quota로 따로 자른다).
 */
export function computeGoogleTrendsCandidateScore(item: GoogleTrendsItem, rank: number): number {
  const rankScore = Math.max(0, RANK_SCORE_MAX - (rank - 1) * (RANK_SCORE_MAX / 20));

  const traffic = item.approxTrafficValue ?? 0;
  const trafficScore = Math.min(TRAFFIC_SCORE_MAX, (traffic / TRAFFIC_FULL_SCORE_THRESHOLD) * TRAFFIC_SCORE_MAX);

  return Math.round(rankScore + trafficScore);
}

export type MapGoogleTrendsOptions = {
  /** 수집 시각 ISO. trend_date와 expires_at의 기준. */
  collectedAt: string;
  /** expires_at = collectedAt + ttlHours. 생략하면 config 값. */
  ttlHours?: number;
};

export function mapGoogleTrendsItemToInsert(
  item: GoogleTrendsItem,
  rank: number,
  options: MapGoogleTrendsOptions
): TrendCandidateInsert {
  const ttlHours = options.ttlHours ?? TREND_SOURCE_CONFIGS.google_trends.candidateTtlHours;
  const collectedAtMs = new Date(options.collectedAt).getTime();
  const expiresAt = new Date(collectedAtMs + ttlHours * 60 * 60 * 1000).toISOString();

  return {
    keyword: item.keyword,
    keyword_normalized: normalize(item.keyword),
    topic: GOOGLE_TRENDS_TOPIC,
    topic_normalized: resolveGoogleTrendsCategory(item),
    source: GOOGLE_TRENDS_SOURCE,
    trend_date: options.collectedAt.slice(0, 10),
    rank,
    movement_type: "flat",
    rank_change: null,
    candidate_score: computeGoogleTrendsCandidateScore(item, rank),
    collected_at: options.collectedAt,
    expires_at: expiresAt,
    status: "active",
    metadata: {
      approxTraffic: item.approxTraffic ?? null,
      approxTrafficValue: item.approxTrafficValue ?? null,
      link: item.link ?? null,
      pubDate: item.pubDate ?? null,
      // 뉴스 제목은 나중에 "이 키워드가 왜 떴는가"를 사람이 확인하는 근거가 된다. 조사 단계에서
      // 재검색 힌트로도 쓸 수 있으므로 상위 3건만 보존한다(row가 과하게 커지지 않도록).
      newsItems: item.newsItems.slice(0, 3),
    },
  };
}

/**
 * 피드 순서를 rank로 사용한다(배열 index + 1). 두 가지를 버린다:
 *
 * - **중복 키워드**: unique index가 (keyword_normalized, topic_normalized, trend_date, source)인데
 *   topic이 고정값이라 같은 키워드는 반드시 conflict key가 겹치고, 한 배치 안에 겹치면 upsert
 *   전체가 거부된다(21000). Creator Advisor 쪽에서 실제로 겪은 문제라 여기서는 처음부터 막는다.
 * - **너무 짧은 키워드**: 1글자 seed는 relevance 필터를 무력화한다(MIN_TREND_KEYWORD_LENGTH 주석).
 *
 * rank는 **버리기 전 피드 순위를 그대로 유지한다.** 버린 만큼 당겨서 매기면 "구글 트렌드에서 몇
 * 위였나"라는 원본 사실이 왜곡되고, candidate_score도 실제보다 높아진다.
 */
export function mapGoogleTrendsItemsToInserts(
  items: readonly GoogleTrendsItem[],
  options: MapGoogleTrendsOptions
): { rows: TrendCandidateInsert[]; droppedCount: number; droppedKeywords: string[] } {
  const rows: TrendCandidateInsert[] = [];
  const seen = new Set<string>();
  const droppedKeywords: string[] = [];

  items.forEach((item, index) => {
    const key = normalize(item.keyword);
    if (seen.has(key) || !isUsableTrendKeyword(item.keyword)) {
      droppedKeywords.push(item.keyword);
      return;
    }
    seen.add(key);
    rows.push(mapGoogleTrendsItemToInsert(item, index + 1, options));
  });

  return { rows, droppedCount: droppedKeywords.length, droppedKeywords };
}
