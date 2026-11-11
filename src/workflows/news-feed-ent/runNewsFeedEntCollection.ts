// 연예 뉴스 피드 수집 -> trend_candidates 저장까지의 배선(collection) 워크플로우.
// runDaumRealtimeCollection.ts와 같은 계약을 따른다: **어떤 실패에도 throw하지 않고 status로만
// 알린다.** 신규 소스가 daily job을 죽이면 안 된다(buildDailyQueryPool.ts fallback 원칙).
//
// 흐름: Google 뉴스 ENTERTAINMENT RSS(이슈 클러스터) + 다음 「많이 본 뉴스」(순위) 조회
//   -> 다음 랭킹 매칭 -> 이슈 구 생성(LLM 1콜, 실패 시 공유 토큰 폴백) -> 상한만큼 자르기
//   -> 제외 어휘 적용 -> upsert.
//
// LLM 호출은 **상한만큼 자른 뒤** 한 번에 한다. 70개 스토리를 다 보내면 프롬프트가 길어지고
// 실패 확률이 올라가는데, 어차피 상위 maxDailyCandidates건만 시드가 된다.

import { TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { describeError } from "../../services/describeError.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import {
  fetchNewsFeedEnt,
  type FetchNewsFeedEntResult,
} from "../../services/search/providers/newsFeedEnt/NewsFeedEntProvider.js";
import { excludeCandidateInserts } from "../keyword-discovery/excludeCandidateInserts.js";
import { extractTopicQueries } from "../keyword-ranking/extractTopicQueries.js";
import {
  mapNewsFeedIssuesToInserts,
  NEWS_FEED_ENT_SOURCE,
  type NewsFeedIssue,
} from "./mapNewsFeedCandidates.js";
import {
  buildIssuePhraseFromStory,
  isUsableIssuePhrase,
  matchDaumRanking,
} from "./newsFeedIssuePhrase.js";

export type RunNewsFeedEntCollectionOptions = {
  /** 생략하면 TREND_SOURCE_CONFIGS.news_feed_ent.enabled. false면 즉시 skipped. */
  enabled?: boolean;
  /** true면 조회/매핑까지만 하고 trend_candidates 쓰기(upsert/expire)를 건너뛴다. */
  dryRun?: boolean;
  /** 만료 처리(expireOldCandidates)를 건너뛴다. 기본 false. */
  skipExpire?: boolean;
  /** 시드로 만들 최대 이슈 수. 생략하면 config 값(15). */
  maxIssues?: number;
  /** 테스트에서 실제 네트워크 대신 결과를 주입하는 지점. */
  fetchFeed?: () => Promise<FetchNewsFeedEntResult>;
  /**
   * 이슈 구 생성기 주입 지점. 생략하면 extractTopicQueries(LLM 1콜).
   * false를 넘기면 LLM을 아예 호출하지 않고 공유 토큰 폴백만 쓴다(오프라인 테스트·비용 0 경로).
   */
  buildPhrases?: typeof extractTopicQueries | false;
};

export type RunNewsFeedEntCollectionResult = {
  status: "success" | "skipped" | "failed";
  reason?: "disabled";
  /** Google 뉴스에서 파싱된 스토리 수(상한 적용 전). */
  fetchedCount: number;
  /** 다음 「많이 본 뉴스」에서 읽은 기사 수. */
  daumRankedCount: number;
  /** 다음 기사 중 Google 스토리와 맞춘 수. */
  daumMatchedCount: number;
  /** 어떤 스토리와도 못 맞춘 다음 기사(시드로 만들지 않는다 - 관측용). */
  daumUnmatched: { rank: number; title: string }[];
  /** 이슈 구를 LLM이 만든 수 / 공유 토큰 폴백으로 만든 수. */
  llmPhraseCount: number;
  fallbackPhraseCount: number;
  /** 실제 upsert된 row 수. dryRun이면 0. */
  upsertedCount: number;
  /** 중복/너무 짧은 구로 버려진 수. */
  droppedCount: number;
  /** 제외 카테고리(육아 등)·정치·스포츠로 걸러져 저장되지 않은 수. */
  excludedCount: number;
  expiredCount: number;
  trendDate: string | null;
  /** 소스별 조회 실패 사유. google_news가 비면 수집 실패다. */
  sourceErrors: FetchNewsFeedEntResult["sourceErrors"];
  error?: string;
};

function emptyResult(status: RunNewsFeedEntCollectionResult["status"]): RunNewsFeedEntCollectionResult {
  return {
    status,
    fetchedCount: 0,
    daumRankedCount: 0,
    daumMatchedCount: 0,
    daumUnmatched: [],
    llmPhraseCount: 0,
    fallbackPhraseCount: 0,
    upsertedCount: 0,
    droppedCount: 0,
    excludedCount: 0,
    expiredCount: 0,
    trendDate: null,
    sourceErrors: {},
  };
}

export async function runNewsFeedEntCollection(
  options: RunNewsFeedEntCollectionOptions = {}
): Promise<RunNewsFeedEntCollectionResult> {
  const enabled = options.enabled ?? TREND_SOURCE_CONFIGS.news_feed_ent.enabled;
  if (!enabled) {
    return { ...emptyResult("skipped"), reason: "disabled" };
  }

  const dryRun = options.dryRun ?? false;
  const maxIssues = options.maxIssues ?? TREND_SOURCE_CONFIGS.news_feed_ent.maxDailyCandidates;

  try {
    const fetched = await (options.fetchFeed ?? (() => fetchNewsFeedEnt()))();

    if (fetched.stories.length === 0) {
      // Google 쪽이 비면 시드를 만들 수 없다. 다음 랭킹만으로는 후보를 만들지 않는다(설계 결정).
      const message =
        fetched.sourceErrors.google_news ?? "Google 뉴스 RSS에서 스토리를 하나도 파싱하지 못했습니다";
      console.error("⚠️ [runNewsFeedEntCollection] 수집할 스토리가 없습니다 -", message);
      return { ...emptyResult("failed"), sourceErrors: fetched.sourceErrors, error: message };
    }

    const matched = matchDaumRanking(fetched.stories, fetched.daumRanking);

    // 다음에 맞은 스토리를 먼저, 그 뒤 피드 순서. 상한만큼만 남긴 뒤에 LLM을 부른다.
    const ranked = [...fetched.stories].sort((a, b) => {
      const rankA = matched.byLeadTitle.get(a.leadTitle)?.daumRank ?? Number.POSITIVE_INFINITY;
      const rankB = matched.byLeadTitle.get(b.leadTitle)?.daumRank ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      return a.feedPosition - b.feedPosition;
    });
    const selected = ranked.slice(0, maxIssues);

    // 이슈 구. LLM 1콜 -> 실패/형식 위반 항목만 공유 토큰 폴백.
    const phraseByLeadTitle = new Map<string, string>();
    if (options.buildPhrases !== false) {
      const buildPhrases = options.buildPhrases ?? extractTopicQueries;
      const extraction = await buildPhrases(
        selected.map((story) => ({ keyword: story.leadTitle, headline: story.leadTitle }))
      );
      if (extraction.error) {
        console.log(`ℹ️ [뉴스피드 이슈 구] ${extraction.status} - ${extraction.error}`);
      }
      for (const entry of extraction.queries) {
        if (entry.source !== "llm" || !isUsableIssuePhrase(entry.query)) continue;
        phraseByLeadTitle.set(entry.keyword, entry.query.trim());
      }
    }

    const issues: NewsFeedIssue[] = selected.map((story) => {
      const llmPhrase = phraseByLeadTitle.get(story.leadTitle);
      return llmPhrase
        ? { story, phrase: llmPhrase, phraseSource: "llm", daum: matched.byLeadTitle.get(story.leadTitle) ?? null }
        : {
            story,
            phrase: buildIssuePhraseFromStory(story),
            phraseSource: "shared_tokens",
            daum: matched.byLeadTitle.get(story.leadTitle) ?? null,
          };
    });

    // 매핑은 순수 함수이므로 DB 접근 전에 끝낸다 - 매핑에서 실패하면 원격에 아무것도 쓰지 않는다.
    const { rows: mapped, droppedCount } = mapNewsFeedIssuesToInserts(issues, {
      collectedAt: fetched.collectedAt,
    });
    const trendDate = mapped[0]?.trend_date ?? fetched.collectedAt.slice(0, 10);

    // 육아·정치·스포츠는 수집 단계에서 원천 차단한다(2026-09-07 채널 개편 + 10/07·10/16 보강).
    const { rows, excludedCount } = excludeCandidateInserts(mapped);

    const base = {
      ...emptyResult("success"),
      fetchedCount: fetched.stories.length,
      daumRankedCount: fetched.daumRanking.length,
      daumMatchedCount: matched.byLeadTitle.size,
      daumUnmatched: matched.unmatched,
      llmPhraseCount: issues.filter((issue) => issue.phraseSource === "llm").length,
      fallbackPhraseCount: issues.filter((issue) => issue.phraseSource === "shared_tokens").length,
      droppedCount,
      excludedCount,
      trendDate,
      sourceErrors: fetched.sourceErrors,
    };

    if (dryRun) return base;

    const upserted = await TrendCandidateRepository.upsertCandidates(rows);

    // 만료는 이 source로 한정한다. 생략하면 다른 소스의 row까지 만료시킨다.
    const expiredCount = options.skipExpire
      ? 0
      : await TrendCandidateRepository.expireOldCandidates({ source: NEWS_FEED_ENT_SOURCE });

    return { ...base, upsertedCount: upserted.length, expiredCount };
  } catch (error) {
    const message = describeError(error);
    console.error("⚠️ [runNewsFeedEntCollection] 수집 실패 -", message);
    return { ...emptyResult("failed"), error: message };
  }
}
