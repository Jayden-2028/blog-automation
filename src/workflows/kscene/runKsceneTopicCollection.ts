// 사용설명서 트랙 주제 수집 -> 저장 -> 알림(개편3 §4.2). 매일 KST 21:00, Worker 12 UTC 슬롯(kscene-topic.yml).
//
// 한국 키워드 파이프라인(runDailyKeywordWorkflow)을 재사용하지 않는다 - NAVER·한국 트렌드 기반이라 영문 에버그린
// 수요와 맞지 않는다. 대신 **같은 저장·알림 경로**를 쓴다: discovery_runs/keyword_rankings에 저장하고
// sendKeywordNotification으로 사용설명서 봇에 Go/Pass를 보내면, Go 이후(research -> write)는 기존 그대로 간다.
//
// 비치명적 단계: 시드 하나의 자동완성 실패, 구글 트렌드(US) 실패, 레딧 실패·차단은 건너뛰고 계속한다. 후보가 0이면 알림 없이
// 실패로 끝낸다(watchdog이 전날분 run을 확인하므로 조용히 completed로 남기지 않는다).

import {
  KSCENE_LABEL_BY_SEED,
  KSCENE_SEEDS,
  KSCENE_TOPIC_CONFIG,
  type KsceneLabel,
  type KsceneSeed,
} from "../../config/ksceneSeeds.js";
import { fetchAutocompleteSuggestions } from "../../services/search/providers/googleAutocomplete/fetchAutocomplete.js";
import { fetchGoogleTrends } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";
import {
  KSCENE_SUBREDDITS,
  RedditBlockedError,
  buildRedditNewUrl,
  buildRedditSearchUrl,
  fetchRedditTitles,
  redditCredentialsFromEnv,
  REDDIT_PUBLIC_MIN_DELAY_MS,
  type RedditCredentials,
} from "../../services/search/providers/reddit/fetchRedditTitles.js";
import { saveRankingHistory } from "../keyword-ranking/saveRankingHistory.js";
import { sendKeywordNotification } from "../keyword-notification/sendKeywordNotification.js";
import {
  attachRedditSupport,
  autocompleteQueriesForSeed,
  buildCandidates,
  normalizeTopic,
  pickSeedsForDay,
  selectTopics,
  toRankedKeywords,
  type SuggestionObservation,
} from "./ksceneTopics.js";
import type { SendKeywordNotificationResult } from "../../types/keywordNotification.js";

export const KSCENE_JOB_KIND = "kscene_topic";

/** 한국·K-컨텍스트 급상승어를 K-Wave Context 시드로 쓴다(영문 US 트렌드 RSS). */
const TREND_KOREA_PATTERN = /\b(korea|korean|seoul|k-?pop|k-?drama|bts|blackpink|stray kids|newjeans|squid game|hallyu|kimchi|hanbok)\b/i;
const MAX_TREND_SEEDS = 3;

export type RunKsceneTopicCollectionOptions = {
  /** 오늘 날짜(일 단위 시드 회전 기준). 테스트 주입. */
  now?: Date;
  seeds?: readonly KsceneSeed[];
  seedsPerRun?: number;
  topicsPerRun?: number;
  /** 요청 사이 대기(ms). 테스트에서는 0. */
  delayMs?: number;
  dryRun?: boolean;
  /** 자동완성 조회. 테스트 주입. */
  fetchSuggestions?: (query: string) => Promise<string[]>;
  /** 레딧 보조 관찰을 돌릴지. 생략하면 KSCENE_TOPIC_CONFIG.redditEnabled(KSCENE_REDDIT_ENABLED, 기본 꺼짐). */
  redditEnabled?: boolean;
  /** 레딧 URL 하나의 제목 목록. 테스트 주입. 403·429는 RedditBlockedError로 던진다. */
  fetchRedditTitles?: (url: string) => Promise<string[]>;
  /** 레딧 요청 사이 대기(ms). 생략하면 KSCENE_TOPIC_CONFIG.redditDelayMs. 공개 RSS 모드에서는 61초 하한을 강제한다. */
  redditDelayMs?: number;
  /** 레딧 OAuth 자격증명. 생략하면 env(REDDIT_CLIENT_ID/SECRET). null이면 공개 RSS 모드. 테스트 주입. */
  redditCredentials?: RedditCredentials | null;
  /** 구글 트렌드(US) 급상승어 조회. 테스트 주입. 실패해도 무시한다. */
  fetchTrendTerms?: () => Promise<string[]>;
  /** 이미 쓴/제안한 주제 목록. 테스트 주입. */
  loadExistingTopics?: () => Promise<string[]>;
  /** 저장·알림. 테스트 주입. */
  save?: typeof saveRankingHistory;
  notify?: typeof sendKeywordNotification;
  log?: (line: string) => void;
};

export type RunKsceneTopicCollectionResult = {
  status: "notified" | "dry_run" | "no_candidates" | "save_failed" | "notify_failed";
  runId: number | null;
  seedsUsed: string[];
  suggestionCount: number;
  candidateCount: number;
  droppedAsDuplicate: number;
  topics: string[];
  failedSeeds: string[];
  trendSeeds: string[];
  reddit: RedditCollectionSummary;
  /** 선정된 주제 중 레딧 질문이 뒷받침한 것(주제 -> 예시 제목). 로그용. */
  redditSupported: { topic: string; hits: number; example: string }[];
  notification?: SendKeywordNotificationResult;
  error?: string;
};

export type RedditCollectionSummary = {
  /** disabled = 스위치 꺼짐, ok = 1건 이상 성공, blocked = 403·429로 중단, failed = 전부 실패. */
  status: "disabled" | "ok" | "blocked" | "failed";
  requests: number;
  titleCount: number;
  error?: string;
};

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** KST 기준 일 단위 정수. 시드 회전·알파벳 변형의 기준이다. */
export function dayIndexOf(date: Date): number {
  return Math.floor((date.getTime() + 9 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000));
}

async function defaultLoadExistingTopics(): Promise<string[]> {
  // 기발행·진행 중 job의 키워드 + 최근 N일간 제안했던 주제. DB 접근은 동적 import로 둔다(순수 테스트가 Supabase를
  // 로드하지 않게 - 이 파일의 다른 함수는 주입으로 대체된다).
  const [{ ArticleJobRepository }, { listRecentDiscoveryRuns }, { listKeywordRankingsByRunId }, { trackOfJob }] = await Promise.all([
    import("../../repositories/ArticleJobRepository.js"),
    import("../../services/supabase/repositories/discoveryRunRepository.js"),
    import("../../services/supabase/repositories/keywordRankingRepository.js"),
    import("../../notifications/telegramTracks.js"),
  ]);

  const topics: string[] = [];
  const jobs = await ArticleJobRepository.listRecent(500);
  for (const job of jobs) {
    if (trackOfJob(job) === "kscene" && job.status !== "rejected") topics.push(job.keyword);
  }

  const cutoff = Date.now() - KSCENE_TOPIC_CONFIG.proposalMemoryDays * 24 * 60 * 60 * 1000;
  // 하루 run이 4건(엔터 1·핫스타 1·사회 1·kscene 1, 2026-10-11 개편)이라 제안 기억 기간(60일)을 덮으려면
  // 240건 넘게 읽어야 한다(전에는 하루 5건 = 300건).
  const runs = await listRecentDiscoveryRuns(400);
  for (const run of runs) {
    if (run.metadata?.kind !== KSCENE_JOB_KIND || Date.parse(run.started_at) < cutoff) continue;
    const rankings = await listKeywordRankingsByRunId(run.id);
    topics.push(...rankings.map((row) => row.keyword));
  }
  return topics;
}

/** 레딧 검색어: 시드에서 korea/korean/south를 뺀다(r/Living_in_Korea 질문은 "korea"를 잘 안 쓴다). */
export function redditQueryForSeed(seed: string): string {
  return normalizeTopic(seed)
    .split(" ")
    .filter((word) => !["korea", "korean", "south"].includes(word))
    .join(" ");
}

/**
 * 레딧 최근 질문 제목 수집(2026-10-28, C). 묶음 new.json 1회 + 시드별 search.json. 403·429면 그 자리에서 멈추고
 * 그때까지 모은 제목만 쓴다(같은 실행에서 다시 두드리지 않는다). 그 밖의 실패는 그 요청만 건너뛴다.
 */
async function collectRedditTitles(
  seedQueries: readonly string[],
  fetchTitles: (url: string) => Promise<string[]>,
  delayMs: number,
  log: (line: string) => void,
  mode: "oauth" | "rss"
): Promise<{ titles: string[]; summary: RedditCollectionSummary }> {
  // OAuth(분당 100회): 묶음 new.json 1회 + 시드별 search.json. 공개 RSS(분당 1회): 서브레딧별 new.rss 3회만 -
  // 시드별 검색까지 하면 한 실행이 20분을 넘는다. 최근 글 300건 제목에 후보 토큰이 있는지로 뒷받침을 센다.
  const urls = mode === "oauth" ? [buildRedditNewUrl(KSCENE_SUBREDDITS)] : KSCENE_SUBREDDITS.map((sub) => buildRedditNewUrl([sub], 100, "rss"));
  if (mode === "oauth") {
    for (const seed of seedQueries) {
      const query = redditQueryForSeed(seed);
      if (query) urls.push(buildRedditSearchUrl(KSCENE_SUBREDDITS, query));
    }
  }

  const titles = new Set<string>();
  let requests = 0;
  let succeeded = 0;
  let lastError: string | undefined;
  for (const [index, url] of urls.entries()) {
    if (index > 0) await sleep(delayMs);
    requests += 1;
    try {
      for (const title of await fetchTitles(url)) titles.add(title);
      succeeded += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof RedditBlockedError) {
        log(`⚠️ 레딧 차단(${error.status}) - 이번 실행에서는 레딧을 건너뜀(비치명적, ${requests}번째 요청)`);
        return { titles: [...titles], summary: { status: "blocked", requests, titleCount: titles.size, error: lastError } };
      }
      log(`⚠️ 레딧 요청 실패(비치명적): ${lastError}`);
    }
  }
  const status = succeeded > 0 ? "ok" : "failed";
  return { titles: [...titles], summary: { status, requests, titleCount: titles.size, ...(status === "failed" ? { error: lastError } : {}) } };
}

export async function runKsceneTopicCollection(
  options: RunKsceneTopicCollectionOptions = {}
): Promise<RunKsceneTopicCollectionResult> {
  const now = options.now ?? new Date();
  const dayIndex = dayIndexOf(now);
  const log = options.log ?? ((line: string) => console.log(line));
  const delayMs = options.delayMs ?? KSCENE_TOPIC_CONFIG.requestDelayMs;
  const fetchSuggestions = options.fetchSuggestions ?? ((query: string) => fetchAutocompleteSuggestions(query));
  const fetchTrendTerms =
    options.fetchTrendTerms ??
    (async () => (await fetchGoogleTrends({ geo: "US" })).items.map((item) => item.keyword));
  const loadExisting = options.loadExistingTopics ?? defaultLoadExistingTopics;
  const save = options.save ?? saveRankingHistory;
  const notify = options.notify ?? sendKeywordNotification;

  // 1) 시드 선정 + (선택) 급상승 한국 관련어를 K-Wave Context 시드로 보강
  const baseSeeds = pickSeedsForDay(options.seeds ?? KSCENE_SEEDS, dayIndex, options.seedsPerRun ?? KSCENE_TOPIC_CONFIG.seedsPerRun);
  const labelBySeed: Record<string, KsceneLabel> = { ...KSCENE_LABEL_BY_SEED };
  for (const seed of options.seeds ?? []) labelBySeed[seed.query] = seed.label;

  const trendSeeds: string[] = [];
  try {
    const terms = await fetchTrendTerms();
    for (const term of terms) {
      if (trendSeeds.length >= MAX_TREND_SEEDS) break;
      if (TREND_KOREA_PATTERN.test(term)) {
        const query = term.toLowerCase();
        trendSeeds.push(query);
        labelBySeed[query] = "K-Wave Context";
      }
    }
  } catch (error) {
    log(`⚠️ 구글 트렌드(US) 조회 실패(비치명적): ${error instanceof Error ? error.message : String(error)}`);
  }

  const seedQueries = [...baseSeeds.map((seed) => seed.query), ...trendSeeds];

  // 2) 자동완성 제안 수집
  const observations: SuggestionObservation[] = [];
  const failedSeeds: string[] = [];
  for (const seed of seedQueries) {
    for (const query of autocompleteQueriesForSeed(seed, dayIndex)) {
      try {
        const suggestions = await fetchSuggestions(query);
        const source = query === seed ? "autocomplete" : "autocomplete_variant";
        suggestions.forEach((suggestion, position) => observations.push({ suggestion, seed, position, source }));
      } catch (error) {
        if (!failedSeeds.includes(seed)) failedSeeds.push(seed);
        log(`⚠️ 자동완성 실패(비치명적) "${query}": ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(delayMs);
    }
  }

  // 3) (선택) 레딧 최근 질문 - 후보를 만들지 않고 자동완성 후보의 교차 신호로만 붙인다(C)
  let reddit: RedditCollectionSummary = { status: "disabled", requests: 0, titleCount: 0 };
  let redditTitles: string[] = [];
  const redditCredentials = options.redditCredentials === undefined ? redditCredentialsFromEnv() : options.redditCredentials;
  const redditMode = redditCredentials ? "oauth" : "rss";
  if (options.redditEnabled ?? KSCENE_TOPIC_CONFIG.redditEnabled) {
    const requestedDelay = options.redditDelayMs ?? KSCENE_TOPIC_CONFIG.redditDelayMs;
    // 테스트(0ms 주입)는 그대로, 실운영 RSS 모드는 61초 하한.
    const redditDelay = redditMode === "rss" && options.redditDelayMs === undefined ? Math.max(requestedDelay, REDDIT_PUBLIC_MIN_DELAY_MS) : requestedDelay;
    const collected = await collectRedditTitles(
      seedQueries,
      options.fetchRedditTitles ?? ((url: string) => fetchRedditTitles(url)),
      redditDelay,
      log,
      redditMode
    );
    reddit = collected.summary;
    redditTitles = collected.titles;
    log(`ℹ️ 레딧 보조 관찰(${redditMode}): ${reddit.status} · 요청 ${reddit.requests}회 · 제목 ${reddit.titleCount}건`);
  }

  // 4) 후보 -> 중복 제거 -> 선정
  const autocompleteCandidates = buildCandidates(observations, labelBySeed);
  const candidates = redditTitles.length > 0 ? attachRedditSupport(autocompleteCandidates, redditTitles) : autocompleteCandidates;
  let existing: string[] = [];
  try {
    existing = await loadExisting();
  } catch (error) {
    // 기발행 목록을 못 읽으면 중복 제안 위험이 있지만, 알림 자체를 막지는 않는다(사람이 Go/Pass로 거른다).
    log(`⚠️ 기발행·기제안 주제 조회 실패(중복 제거 생략): ${error instanceof Error ? error.message : String(error)}`);
  }
  const { selected, droppedAsDuplicate } = selectTopics(candidates, {
    topN: options.topicsPerRun ?? KSCENE_TOPIC_CONFIG.topicsPerRun,
    existingTopics: existing,
    similarity: KSCENE_TOPIC_CONFIG.duplicateSimilarity,
  });

  const base = {
    seedsUsed: seedQueries,
    suggestionCount: observations.length,
    candidateCount: candidates.length,
    droppedAsDuplicate,
    topics: selected.map((item) => item.topic),
    failedSeeds,
    trendSeeds,
    reddit,
    redditSupported: selected
      .filter((item) => (item.redditHits ?? 0) > 0)
      .map((item) => ({ topic: item.topic, hits: item.redditHits ?? 0, example: item.redditExample ?? "" })),
  };

  for (const item of base.redditSupported) log(`   🟠 레딧 뒷받침 ${item.hits}건: ${item.topic} ← "${item.example}"`);

  if (selected.length === 0) {
    return { status: "no_candidates", runId: null, ...base, error: "제안할 주제가 없습니다(자동완성 0건이거나 전부 제외·중복)" };
  }

  if (options.dryRun) {
    return { status: "dry_run", runId: null, ...base };
  }

  // 5) 저장(discovery_runs + keyword_rankings) - Go/Pass 버튼이 (run_id, rank)로 이 행을 가리킨다.
  const saved = await save({
    startedAt: now,
    seedQueries,
    source: "google_autocomplete",
    metadata: { kind: KSCENE_JOB_KIND, track: "kscene", reddit },
    candidatesCount: candidates.length,
    clustersCount: selected.length,
    errorCount: failedSeeds.length,
    ranked: toRankedKeywords(selected),
  });
  if (!saved.persisted || saved.runId === null) {
    return { status: "save_failed", runId: saved.runId, ...base, error: saved.error ?? "ranking 저장 실패" };
  }

  // 6) 사용설명서 봇으로 알림
  const notification = await notify({
    track: "kscene",
    runId: saved.runId,
    topN: selected.length,
    headerTitle: "🌏 <b>사용설명서 주제 제안</b>",
    evergreen: true,
  });
  if (!notification.sent) {
    return { status: "notify_failed", runId: saved.runId, ...base, notification, error: `알림 미발송 (${notification.reason ?? "unknown"})` };
  }
  return { status: "notified", runId: saved.runId, ...base, notification };
}
