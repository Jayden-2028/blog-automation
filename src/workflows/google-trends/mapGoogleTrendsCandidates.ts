// 구글 트렌드 RSS 항목 -> trend_candidates insert row 변환(순수 함수).
// mapCreatorAdvisorCandidates.ts와 같은 층위이며, DB 접근은 하지 않는다.
//
// Creator Advisor와 다른 점 세 가지:
//
// 1) topic이 없다. 구글 트렌드는 분야 구분 없이 순위 목록 하나만 준다. 그래서 topic에는 고정값
//    "google_trends"를 넣고(원문 보존 필드이므로 거짓 분야명을 지어내지 않는다), topic_normalized는
//    키워드 어휘 분류(classifyKeywordCategory)에 전적으로 의존한다. 어휘 신호가 없으면 폴백할 topic
//    매핑이 없으므로 "living"으로 둔다 - 미분류를 뜻하는 별도 값을 새로 만들면 category를 소비하는
//    쪽(diversity backfill, 원고 톤)이 전부 그 값을 몰라 조용히 어긋난다.
//
// 2) movement_type을 알 수 없다. 피드는 "지금 급상승"만 주고 어제 대비 순위 변화를 주지 않는다.
//    전부 "new"로 두는 것은 거짓이므로("어제도 1위였던 키워드"를 new라고 하게 된다) "flat"을 쓴다 -
//    스키마가 허용하는 네 값 중 "변화 정보 없음"에 가장 가까운 중립값이다. rank_change는 null.
//
// 3) candidate_score를 순위와 검색량으로 만든다. Creator Advisor는 rank + movement로 계산하는데
//    (scoreCreatorAdvisorCandidate.ts) 여기엔 movement가 없다. 대신 피드가 approx_traffic을 준다.

import { TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { classifyKeywordCategory } from "../../config/keywordCategoryRules.js";
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
    topic_normalized: classifyKeywordCategory(item.keyword) ?? FALLBACK_CATEGORY,
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
 * 피드 순서를 rank로 사용한다(배열 index + 1). 같은 키워드가 두 번 나오면 뒤쪽을 버린다 -
 * unique index가 (keyword_normalized, topic_normalized, trend_date, source)인데 topic이 고정값이라
 * 같은 키워드는 반드시 conflict key가 겹치고, 한 배치 안에 겹치면 upsert 전체가 거부된다(21000).
 * Creator Advisor 쪽에서 실제로 겪은 문제라 여기서는 처음부터 막는다.
 */
export function mapGoogleTrendsItemsToInserts(
  items: readonly GoogleTrendsItem[],
  options: MapGoogleTrendsOptions
): { rows: TrendCandidateInsert[]; droppedCount: number } {
  const rows: TrendCandidateInsert[] = [];
  const seen = new Set<string>();
  let droppedCount = 0;

  items.forEach((item, index) => {
    const key = normalize(item.keyword);
    if (seen.has(key)) {
      droppedCount++;
      return;
    }
    seen.add(key);
    rows.push(mapGoogleTrendsItemToInsert(item, index + 1, options));
  });

  return { rows, droppedCount };
}
