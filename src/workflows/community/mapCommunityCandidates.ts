// LLM이 추출한 커뮤니티 키워드 -> trend_candidates insert row 변환(순수 함수).
// mapGoogleTrendsCandidates.ts와 같은 층위이며, DB 접근은 하지 않는다.
//
// 구글 트렌드/Creator Advisor와 다른 점 두 가지:
//
// 1) topic이 없다(구글 트렌드와 같은 이유). topic에는 고정값 "community"를 넣는다.
//    category는 LLM이 준 값을 우선 신뢰하고, 없거나 유효하지 않으면 keyword 어휘 규칙
//    (classifyKeywordCategory - 더쿠에서 온 연예 뉴스가 entertainment로 가도록)으로 한 번 더
//    시도한 뒤, 그래도 안 잡히면 "community" 자체로 폴백한다. 구글 트렌드는 미분류 폴백이
//    "living"인데, 여기는 다르다 - 이 소스 자체가 "인터넷에서 화제인 것"이라는 정의이므로,
//    끝까지 못 잡은 항목이 생활정보(living)보다는 화제/밈(community)에 더 가깝다.
// 2) rank/score에 검색량이 없다. 있는 신호는 그 사이트 인기글 목록 안에서의 순위(siteRank)뿐이라
//    구글 트렌드보다 신호가 약하다 - EXTERNAL_TREND_QUERY_PRIORITY(buildDailyQueryPool.ts)가
//    이 소스를 Creator Advisor보다 낮은 priority로 두는 것과 같은 이유다.

import { TREND_SOURCE_CONFIGS, isUsableTrendKeyword } from "../../config/trendSources.js";
import { classifyKeywordCategory, type KeywordCategory } from "../../config/keywordCategoryRules.js";
import type { CommunityPostInput, ExtractedCommunityItem } from "./extractCommunityKeywords.js";
import type { TrendCandidateInsert } from "../../types/database.js";

export const COMMUNITY_SOURCE = "community";
/** trend_candidates.topic에 저장할 고정값. 커뮤니티는 분야를 주지 않는다(파일 상단 주석). */
export const COMMUNITY_TOPIC = "community";
/** 어휘 신호가 전혀 없을 때의 category. 구글 트렌드(living)와 다르다(파일 상단 주석). */
const FALLBACK_CATEGORY: KeywordCategory = "community";

/** siteRank 1이 이 점수를 받고 순위가 내려갈수록 선형 감소한다. 검색량 신호가 없어 만점을 구글
 * 트렌드(rank 30 + traffic 20 = 50)보다 낮게 잡는다 - 이 소스가 상대적으로 약한 신호임을
 * candidate_score 스케일에도 반영한다. */
const RANK_SCORE_MAX = 30;
/** 이 순위 밖이면 점수가 0에 가까워진다. 사이트별 인기글 목록 길이를 아직 실측하지 못했으므로
 * 보수적으로 넉넉히 잡는다(실측 후 조정 대상). */
const RANK_SCORE_FLOOR_POSITION = 20;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * LLM category -> keyword 어휘 -> community 폴백 순으로 category를 정한다(파일 상단 주석).
 */
export function resolveCommunityCategory(
  extractedCategory: KeywordCategory | null,
  keyword: string
): KeywordCategory {
  return extractedCategory ?? classifyKeywordCategory(keyword) ?? FALLBACK_CATEGORY;
}

export function computeCommunityCandidateScore(siteRank: number): number {
  const score = RANK_SCORE_MAX - (siteRank - 1) * (RANK_SCORE_MAX / RANK_SCORE_FLOOR_POSITION);
  return Math.max(0, Math.round(score));
}

export type MapCommunityCandidatesOptions = {
  /** 수집 시각 ISO. trend_date와 expires_at의 기준. */
  collectedAt: string;
  /** expires_at = collectedAt + ttlHours. 생략하면 config 값. */
  ttlHours?: number;
};

export type MapCommunityCandidatesResult = {
  rows: TrendCandidateInsert[];
  droppedCount: number;
  droppedKeywords: string[];
};

/**
 * extractCommunityKeywords 결과 + 원본 posts -> trend_candidates insert row.
 *
 * 버리는 두 가지는 구글 트렌드와 같다(mapGoogleTrendsCandidates.ts 참고):
 * - 배치 내 중복 키워드(conflict key가 (keyword_normalized, topic_normalized, trend_date, source)라
 *   topic이 고정값이면 같은 키워드가 반드시 겹친다 - 21000 예방)
 * - 너무 짧은 키워드(MIN_TREND_KEYWORD_LENGTH)
 *
 * rank는 LLM이 뽑아준 순서(extracted 배열 순서) 그대로 1부터 매긴다 - 여러 사이트를 한 배치로
 * 합친 뒤라 원본 siteRank는 사이트마다 기준이 달라(사이트 A 5위 vs 사이트 B 5위가 같은 뜻이 아님)
 * 배치 전체의 순위로 쓸 수 없다. siteRank는 site별 후속 분석을 위해 metadata에 남긴다.
 */
export function mapCommunityItemsToInserts(
  posts: readonly CommunityPostInput[],
  extracted: readonly ExtractedCommunityItem[],
  options: MapCommunityCandidatesOptions
): MapCommunityCandidatesResult {
  const ttlHours = options.ttlHours ?? TREND_SOURCE_CONFIGS.community.candidateTtlHours;
  const collectedAtMs = new Date(options.collectedAt).getTime();
  const expiresAt = new Date(collectedAtMs + ttlHours * 60 * 60 * 1000).toISOString();
  const trendDate = options.collectedAt.slice(0, 10);

  const rows: TrendCandidateInsert[] = [];
  const seen = new Set<string>();
  const droppedKeywords: string[] = [];
  let rank = 0;

  for (const item of extracted) {
    const post = posts[item.index];
    if (!post) {
      // parseExtractionOutput이 이미 범위를 검증하지만, 방어적으로 한 번 더 확인한다.
      droppedKeywords.push(item.keyword);
      continue;
    }

    if (!isUsableTrendKeyword(item.keyword)) {
      droppedKeywords.push(item.keyword);
      continue;
    }

    const category = resolveCommunityCategory(item.category, item.keyword);
    const key = `${normalize(item.keyword)}|${category}`;
    if (seen.has(key)) {
      droppedKeywords.push(item.keyword);
      continue;
    }
    seen.add(key);
    rank += 1;

    rows.push({
      keyword: item.keyword,
      keyword_normalized: normalize(item.keyword),
      topic: COMMUNITY_TOPIC,
      topic_normalized: category,
      source: COMMUNITY_SOURCE,
      trend_date: trendDate,
      rank,
      movement_type: "flat",
      rank_change: null,
      candidate_score: computeCommunityCandidateScore(post.siteRank),
      collected_at: options.collectedAt,
      expires_at: expiresAt,
      status: "active",
      metadata: {
        site: post.site,
        siteRank: post.siteRank,
        sourceTitle: post.title,
      },
    });
  }

  return { rows, droppedCount: droppedKeywords.length, droppedKeywords };
}
