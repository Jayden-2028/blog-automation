// 뉴스 피드 스토리 -> trend_candidates insert row 변환(순수 함수. DB 접근 없음).
// mapDaumRealtimeCandidates.ts / mapGoogleTrendsCandidates.ts와 같은 층위다.
//
// 순위(rank)의 근거가 다른 소스와 다르다. 구글 트렌드·다음 실시간은 소스가 순위를 주지만,
// 여기서는 두 신호를 합쳐 우리가 정한다(KEYWORD-ENT-REDESIGN-2026-11.md R1):
//   ① 다음 「많이 본 뉴스」 순위 — 한국 독자가 실제로 읽은 순서. 가장 강한 신호다.
//   ② Google 피드 등장 순서 — 다음에서 못 맞춘 스토리의 폴백.
// ①에 맞은 스토리가 ②보다 항상 앞선다. 「많이 본 뉴스」가 10건뿐이므로 상위 10칸을 ①이 채우고
// 그 뒤를 ②가 잇는다.
//
// topic은 고정값이다. 이 피드는 **연예 토픽 피드**라 분야가 이미 확정돼 있고, 분야를 다시 추측하면
// (classifyKeywordCategory로) 2026-11-10 run 260처럼 `외도`·`징역` 같은 낱말에 끌려 incident로
// 떨어진다. 그러면 엔터 트랙이 자기가 읽어 온 연예 기사를 자기 풀에서 빼는 셈이다.
// 다만 **제외 어휘(스포츠·정치·육아)는 그대로 적용된다** - 상위 excludeCandidateInserts가 맡는다.

import { TREND_SOURCE_CONFIGS, isUsableTrendKeyword } from "../../config/trendSources.js";
import type { GoogleNewsStory } from "../../services/search/providers/newsFeedEnt/parseGoogleNewsRss.js";
import type { TrendCandidateInsert } from "../../types/database.js";
import type { DaumMatch } from "./newsFeedIssuePhrase.js";

export const NEWS_FEED_ENT_SOURCE = "news_feed_ent";
/** trend_candidates.topic 고정값. 연예 토픽 피드라 분야가 이미 확정돼 있다(파일 상단 주석). */
export const NEWS_FEED_ENT_TOPIC = "news_feed_ent";
/** topic_normalized 고정값. 엔터 트랙의 includeCategories(entertainment/ott)에 들어가야 한다. */
export const NEWS_FEED_ENT_CATEGORY = "entertainment";

/** 다음 1위가 받는 점수. 순위가 내려갈수록 선형 감소한다(다른 소스의 스케일과 맞춘다). */
export const DAUM_RANK_SCORE_MAX = 35;
/** 다음에서 못 맞춘 스토리가 피드 1위에서 받는 점수. 다음 10위(=4.5점)보다 낮게 둔다. */
export const FEED_POSITION_SCORE_MAX = 4;
/** 매체 수 가점. `<ol>`이 5에서 잘려 포화되므로 작게 둔다(parseGoogleNewsRss.ts 상단). */
export const OUTLET_BONUS_PER_SOURCE = 1;
export const OUTLET_BONUS_MIN_COUNT = 3;

export type NewsFeedIssue = {
  story: GoogleNewsStory;
  /** 실제로 시드가 될 이슈 구(LLM 또는 공유 토큰 폴백). */
  phrase: string;
  /** 구를 누가 만들었나. 실측 로그에서 LLM 품질을 판단하려면 구분이 필요하다. */
  phraseSource: "llm" | "shared_tokens";
  /** 다음 랭킹 매칭 결과. 못 맞췄으면 null. */
  daum: DaumMatch | null;
};

export function computeNewsFeedScore(issue: NewsFeedIssue): number {
  const base = issue.daum
    ? Math.max(0, DAUM_RANK_SCORE_MAX - (issue.daum.daumRank - 1) * (DAUM_RANK_SCORE_MAX / 10))
    : Math.max(0, FEED_POSITION_SCORE_MAX - (issue.story.feedPosition - 1) * 0.05);

  const outletBonus =
    issue.story.outletCount >= OUTLET_BONUS_MIN_COUNT
      ? (issue.story.outletCount - OUTLET_BONUS_MIN_COUNT + 1) * OUTLET_BONUS_PER_SOURCE
      : 0;

  return Math.round(base + outletBonus);
}

export type MapNewsFeedOptions = {
  /** 수집 시각 ISO. trend_date와 expires_at의 기준. */
  collectedAt: string;
  /** expires_at = collectedAt + ttlHours. 생략하면 config 값. */
  ttlHours?: number;
};

/**
 * 이슈 목록 -> insert row 목록. 순위는 "다음에 맞은 것 먼저(다음 순위대로), 그 뒤 피드 순서"다.
 *
 * 같은 규약으로 두 가지를 버린다(mapDaumRealtimeCandidates.ts 참고): 중복 키워드(같은 배치에서
 * unique conflict key가 겹치면 upsert 전체가 21000으로 거부된다)와 너무 짧은 키워드
 * (relevance 필터를 무력화한다 - config/trendSources.ts 주석).
 */
export function mapNewsFeedIssuesToInserts(
  issues: readonly NewsFeedIssue[],
  options: MapNewsFeedOptions
): { rows: TrendCandidateInsert[]; droppedCount: number; droppedPhrases: string[] } {
  const ttlHours = options.ttlHours ?? TREND_SOURCE_CONFIGS.news_feed_ent.candidateTtlHours;
  const expiresAt = new Date(new Date(options.collectedAt).getTime() + ttlHours * 60 * 60 * 1000).toISOString();
  const trendDate = options.collectedAt.slice(0, 10);

  const ordered = [...issues].sort((a, b) => {
    if (a.daum && b.daum) return a.daum.daumRank - b.daum.daumRank;
    if (a.daum) return -1;
    if (b.daum) return 1;
    return a.story.feedPosition - b.story.feedPosition;
  });

  const rows: TrendCandidateInsert[] = [];
  const droppedPhrases: string[] = [];
  const seen = new Set<string>();

  for (const issue of ordered) {
    const phrase = issue.phrase.trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key) || !isUsableTrendKeyword(phrase)) {
      droppedPhrases.push(issue.phrase);
      continue;
    }
    seen.add(key);

    rows.push({
      keyword: phrase,
      keyword_normalized: key,
      topic: NEWS_FEED_ENT_TOPIC,
      topic_normalized: NEWS_FEED_ENT_CATEGORY,
      source: NEWS_FEED_ENT_SOURCE,
      trend_date: trendDate,
      rank: rows.length + 1,
      // 피드는 "어제보다 올랐나"를 주지 않는다. 없음을 flat으로 적는다(up/down을 지어내지 않는다).
      movement_type: "flat",
      rank_change: null,
      candidate_score: computeNewsFeedScore(issue),
      collected_at: options.collectedAt,
      expires_at: expiresAt,
      status: "active",
      metadata: {
        leadTitle: issue.story.leadTitle,
        leadOutlet: issue.story.leadOutlet,
        feedPosition: issue.story.feedPosition,
        publishedAt: issue.story.publishedAt,
        // `<ol>`이 5건에서 잘리므로 **하한**이다(parseGoogleNewsRss.ts 상단). R9에서 trendMomentum을
        // 대체할 재료로 쓰려면 이 포화를 먼저 풀어야 한다는 사실을 데이터에 남겨 둔다.
        outletCount: issue.story.outletCount,
        outletCountSaturated: issue.story.outletCount >= 5,
        outlets: issue.story.related.map((article) => article.outlet).filter(Boolean),
        relatedTitles: issue.story.related.map((article) => article.title),
        phraseSource: issue.phraseSource,
        daumRank: issue.daum?.daumRank ?? null,
        daumSharedTokens: issue.daum?.sharedTokens ?? null,
      },
    });
  }

  return { rows, droppedCount: droppedPhrases.length, droppedPhrases };
}
