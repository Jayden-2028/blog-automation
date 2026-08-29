// daily query pool 조립: seed_queries(stable/base) + trend_candidates(dynamic, 여러 소스)를
// normalize/dedupe해서 하나의 query 목록으로 합친다.
//
// 역할 분리(중요): 동적 소스 데이터는 seed_queries에 직접 영구 등록하지 않는다.
// - seed_queries: 장기적으로 유지되는 stable/base 검색어(사람이 직접 큐레이션).
// - trend_candidates: Creator Advisor / 구글 트렌드 / 다음 실시간 / 커뮤니티 등에서 매일 생성되는
//   dynamic 검색 후보. 어느 소스인지는 source 컬럼으로 구분한다.
// 이 함수는 매 호출마다 두 층을 즉석에서 merge할 뿐, trend_candidates의 내용을 seed_queries로
// 승격시키지 않는다.
//
// 다중 소스(2026-08-29): 이전에는 source="creator_advisor" 하나만 하드코딩으로 읽었다. 지금은
// config/trendSources.ts의 enabled 소스를 순회하며 소스별 quota만큼 뽑아 합친다. 스키마 변경은
// 필요 없었다 - trend_candidates의 unique index에 이미 source가 포함돼 있다.
//
// 주의(요구사항 #10): 이 파일은 query 목록을 "누가 조회할지" 조립만 할 뿐, 이후 단계인
// keyword-discovery(수집)/keyword-ranking(clustering/scoring)의 로직에는 관여하지 않는다.
// collectNaverCandidates/scoreKeyword/CompositeSimilarityClusterer 등은 이 파일이 만든
// queries 배열을 기존과 동일한 형태(string[])로 그대로 받는다.
//
// fallback 보장(요구사항 #7): 어떤 소스가 disabled이거나 조회에 실패해도(로그인 실패/not ready/
// browser error/timeout/available 날짜 없음 등 사유 무관) 이 함수는 예외를 던지지 않고 나머지
// 소스로 구성된 결과를 반환한다. 전부 실패해도 seed_queries만으로 정상 동작한다 - 그래서
// dailyKeywordWorkflow.ts의 "seed" 단계는 이 함수 하나만 호출하면 되고 소스별 분기를 두지 않는다.
// 동적 소스는 전부 seed_queries 파이프라인을 보강하는 enrichment일 뿐, 필수 의존성이 아니다.

import { TREND_SOURCE_CONFIGS, TREND_SOURCES, type TrendSource } from "../../config/trendSources.js";
import { SeedQueryRepository } from "../../repositories/SeedQueryRepository.js";
import { describeError } from "../../services/describeError.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { selectTopCreatorAdvisorCandidates } from "../creator-advisor/selectTopCreatorAdvisorCandidates.js";
import type { SeedQueryRow, TrendCandidateRow } from "../../types/database.js";

// "trend"는 seed가 아닌 모든 동적 소스를 뭉뚱그린 값이다. 어느 소스에서 왔는지는 entry.source에
// 남는다 - origin은 "사람이 등록한 상시 검색어인가 아닌가"라는 축이고, source는 "어디서 왔나"라는
// 별개 축이라 둘을 한 필드에 섞지 않는다(topicGrouping의 분류어 판정이 origin 축을 사용한다).
export type QueryPoolOrigin = "seed" | "creator_advisor" | "trend" | "merged";

export type QueryPoolEntry = {
  keyword: string;
  category: string;
  /** 대표 seedQuery 동률 판정 등에 쓰이는 운영 priority. seed는 seed_queries.priority, CA는 고정값. */
  priority: number;
  origin: QueryPoolOrigin;
  /** 이 entry가 온 trend_candidates.source. origin="seed"면 null. */
  source: TrendSource | null;
  /**
   * Creator Advisor 유래 신호(topic 원본/trendDate/movementType/rank/rankChange/candidateScore)를
   * 담는다. origin="seed"면 빈 객체. origin="merged"면 metadata.creatorAdvisor에 CA 쪽 신호가
   * 보존된다(요구사항: "Creator Advisor signal은 metadata로 잃지 않도록").
   */
  metadata: Record<string, unknown>;
};

export type LoadTrendCandidates = () => Promise<{
  trendDate: string | null;
  candidates: TrendCandidateRow[];
}>;

export type BuildDailyQueryPoolResult = {
  entries: QueryPoolEntry[];
  seedCount: number;
  /** Daily Query Pool에 새로 추가된 동적 소스 entry 수 합계(merge로 흡수된 것은 제외). */
  trendCount: number;
  /** source별 내역. 어느 소스가 실제로 기여했는지 알아야 quota를 조정할 수 있다. */
  trendCountBySource: Partial<Record<TrendSource, number>>;
  /** seed_queries와 keyword가 겹쳐 origin="merged"로 흡수된 동적 후보 수. */
  trendMergedCount: number;
  /**
   * 조회에 실패한 소스가 있을 때만 채워진다. 실패해도 entries는 나머지 소스로 채워져 반환된다.
   * 단수형 trendError는 하위 호환용으로, 실패한 소스 중 첫 번째 메시지를 담는다.
   */
  trendError?: string;
  trendErrorBySource: Partial<Record<TrendSource, string>>;
};

export type BuildDailyQueryPoolOptions = {
  /**
   * 테스트/로컬 검증에서만 설정을 덮어쓴다. 운영 호출은 config의 enabled 값을 그대로 쓴다.
   * creator_advisor 소스에만 적용된다(하위 호환: 이 옵션이 있기 전부터 쓰이던 이름이다).
   */
  creatorAdvisorEnabled?: boolean;
  /** 이 목록에 있는 소스만 조회한다. 생략하면 TREND_SOURCE_CONFIGS의 enabled를 따른다. */
  enabledSources?: readonly TrendSource[];
  /** 실제 DB insert 없이 merge/fallback을 검증하기 위한 조회 함수 주입 지점. */
  loadActiveSeeds?: () => Promise<SeedQueryRow[]>;
  /** creator_advisor 전용 loader(하위 호환). loadCandidatesBySource보다 우선한다. */
  loadLatestCreatorAdvisorCandidates?: LoadTrendCandidates;
  /** source별 loader 주입. 지정하지 않은 소스는 TrendCandidateRepository를 쓴다. */
  loadCandidatesBySource?: Partial<Record<TrendSource, LoadTrendCandidates>>;
};

// 동적 소스 기반 entry의 기본 priority. seed_queries 기본값(5)보다 낮게 둬서, 같은 우선순위
// 동률 상황에서는 사람이 직접 큐레이션한 seed가 우선하도록 한다. scoring/ranking 로직 자체는
// 건드리지 않는다 - aggregateClusterSignals가 대표 seedQuery를 고를 때 참고하는 값일 뿐이다.
const CREATOR_ADVISOR_QUERY_PRIORITY = 3;

// creator_advisor보다 한 단계 더 낮다. 신규 소스는 아직 실측 운영 이력이 없고, Creator Advisor는
// 네이버 블로그에서 실제로 검색된 키워드라 이 프로젝트의 발행 채널과 가장 직접 연결돼 있다.
const EXTERNAL_TREND_QUERY_PRIORITY = 2;

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function buildSeedEntry(seed: SeedQueryRow): QueryPoolEntry {
  return {
    keyword: seed.keyword,
    category: seed.category,
    priority: seed.priority,
    origin: "seed",
    source: null,
    metadata: {},
  };
}

/**
 * trend_candidates row 하나 -> QueryPoolEntry. category는 topic_normalized(내부 category mapping
 * 결과)를 쓴다. origin은 creator_advisor만 기존 값을 유지하고 나머지 소스는 "trend"로 묶는다 -
 * 기존 소비자(하위 호환)와 신규 소스 구분을 동시에 만족시키기 위함이며, 정확한 출처는 source에 있다.
 */
function buildTrendEntry(row: TrendCandidateRow, source: TrendSource): QueryPoolEntry {
  return {
    keyword: row.keyword,
    category: row.topic_normalized,
    priority: source === "creator_advisor" ? CREATOR_ADVISOR_QUERY_PRIORITY : EXTERNAL_TREND_QUERY_PRIORITY,
    origin: source === "creator_advisor" ? "creator_advisor" : "trend",
    source,
    metadata: {
      topic: row.topic,
      trendDate: row.trend_date,
      movementType: row.movement_type,
      rank: row.rank,
      rankChange: row.rank_change,
      candidateScore: row.candidate_score,
    },
  };
}

/** origin이 동적 소스(seed가 아님)인지. */
function isTrendOrigin(origin: QueryPoolOrigin): boolean {
  return origin === "creator_advisor" || origin === "trend";
}

// keyword(trim+lowercase) 기준으로 seed/동적 소스 후보를 merge한다. 같은 keyword가 양쪽에
// 있으면 seed를 primary로 유지하되(요구사항: "중복 keyword가 있으면 stable seed를 우선"),
// 동적 소스 signal은 잃지 않도록 origin을 "merged"로 표시하고 metadata.creatorAdvisor에
// 그 entry의 metadata를 그대로 보존한다.
//
// metadata 키 이름이 "creatorAdvisor"로 남아 있는 것은 의도적이다: 이미 저장된 discovery_runs
// metadata와 이걸 읽는 코드가 있어 이름을 바꾸면 조용히 끊긴다. 실제 출처는 같은 객체의
// source 필드로 구분한다.
function mergeEntries(
  seedEntries: QueryPoolEntry[],
  trendEntries: QueryPoolEntry[]
): { entries: QueryPoolEntry[]; mergedCount: number } {
  const byKeyword = new Map<string, QueryPoolEntry>();
  for (const entry of seedEntries) {
    byKeyword.set(normalizeKeyword(entry.keyword), entry);
  }

  let mergedCount = 0;
  for (const trendEntry of trendEntries) {
    const key = normalizeKeyword(trendEntry.keyword);
    const existing = byKeyword.get(key);

    if (existing?.origin === "seed" || existing?.origin === "merged") {
      mergedCount++;

      // 같은 seed keyword가 여러 소스/topic에 동시에 등장할 수 있다. 이때 순회 순서에 따라
      // 마지막 신호로 덮어쓰지 않고 candidateScore가 가장 높은 신호를 보존한다.
      const currentSignal = existing.metadata.creatorAdvisor as Record<string, unknown> | undefined;
      const currentScore = Number(currentSignal?.candidateScore ?? Number.NEGATIVE_INFINITY);
      const nextScore = Number(trendEntry.metadata.candidateScore ?? 0);
      if (existing.origin === "merged" && nextScore <= currentScore) continue;

      byKeyword.set(key, {
        ...existing,
        origin: "merged",
        metadata: {
          ...existing.metadata,
          creatorAdvisor: { ...trendEntry.metadata, source: trendEntry.source },
        },
      });
    } else if (existing && isTrendOrigin(existing.origin)) {
      // 같은 keyword가 서로 다른 topic/소스 row로 존재할 수 있다(unique key에 topic과 source가
      // 포함됨). seed와 합쳐진 것이 아니므로 origin/mergedCount를 바꾸지 않고 더 높은 pre-score를 남긴다.
      const existingScore = Number(existing.metadata.candidateScore ?? 0);
      const nextScore = Number(trendEntry.metadata.candidateScore ?? 0);
      if (nextScore > existingScore) byKeyword.set(key, trendEntry);
    } else {
      byKeyword.set(key, trendEntry);
    }
  }

  return { entries: [...byKeyword.values()], mergedCount };
}

/**
 * 이 소스를 이번 run에서 조회할지 판정한다. 우선순위가 높은 것부터:
 *
 * 1. creatorAdvisorEnabled — creator_advisor 하나만 켜고 끄는 명시적 override(하위 호환 옵션).
 *    **enabledSources보다 우선한다.** 이 옵션이 있기 전부터 "false면 조회조차 하지 않는다"가
 *    계약이었고, 나중에 추가된 enabledSources가 그걸 덮으면 조용히 계약이 깨진다.
 * 2. enabledSources — 테스트/로컬에서 조회 대상을 좁힐 때.
 * 3. TREND_SOURCE_CONFIGS[source].enabled — 운영 기본값(env).
 */
function isSourceEnabled(source: TrendSource, options: BuildDailyQueryPoolOptions): boolean {
  if (source === "creator_advisor" && options.creatorAdvisorEnabled !== undefined) {
    return options.creatorAdvisorEnabled;
  }
  if (options.enabledSources) return options.enabledSources.includes(source);
  return TREND_SOURCE_CONFIGS[source].enabled;
}

function resolveEnabledSources(options: BuildDailyQueryPoolOptions): TrendSource[] {
  return TREND_SOURCES.filter((source) => isSourceEnabled(source, options));
}

function resolveLoader(source: TrendSource, options: BuildDailyQueryPoolOptions): LoadTrendCandidates {
  if (source === "creator_advisor" && options.loadLatestCreatorAdvisorCandidates) {
    return options.loadLatestCreatorAdvisorCandidates;
  }
  const injected = options.loadCandidatesBySource?.[source];
  if (injected) return injected;

  return () => TrendCandidateRepository.listLatestActiveCandidates(source);
}

export async function buildDailyQueryPool(
  options: BuildDailyQueryPoolOptions = {}
): Promise<BuildDailyQueryPoolResult> {
  const loadActiveSeeds = options.loadActiveSeeds ?? (() => SeedQueryRepository.getActiveSeeds());

  const activeSeeds = await loadActiveSeeds();
  const seedEntries = activeSeeds.map(buildSeedEntry);

  const enabledSources = resolveEnabledSources(options);
  const trendErrorBySource: Partial<Record<TrendSource, string>> = {};
  const trendEntries: QueryPoolEntry[] = [];

  for (const source of enabledSources) {
    try {
      // latestAvailableTrendDate의 active 후보만 사용한다(오늘/어제로 날짜를 고정하지 않는다 -
      // 수집기가 이미 "데이터가 있는 날짜"를 trend_date로 저장해뒀으므로 그 값을 그대로 신뢰한다).
      const { candidates } = await resolveLoader(source, options)();

      // 소스별 quota + topic diversity로 상위 일부만 고른다. 전체를 다 NAVER API 검증에 보내면
      // collect 단계 소요 시간이 소스 수에 비례해 폭증한다.
      const config = TREND_SOURCE_CONFIGS[source];
      const scored = candidates.map((row) => ({ ...row, candidateScore: row.candidate_score ?? 0 }));
      const selected = selectTopCreatorAdvisorCandidates(scored, {
        maxTotal: config.maxDailyCandidates,
        maxPerTopic: config.maxCandidatesPerTopic,
      });

      trendEntries.push(...selected.map((row) => buildTrendEntry(row, source)));
    } catch (error) {
      // 개별 소스 실패는 daily workflow 전체를 막지 않는다(요구사항 #7). 로그인 실패/not ready/
      // browser error/timeout/available 날짜 없음 등 사유가 무엇이든 나머지 소스로 진행한다.
      //
      // describeError를 쓰는 이유: 여기서 오는 오류는 대부분 Supabase PostgrestError이고, 그건
      // Error 인스턴스가 아니라 평범한 객체라 String(error)가 "[object Object]"를 만든다.
      // 이 문자열이 그대로 trendErrorBySource -> Telegram 실패 알림까지 가므로 원인이 사라지면
      // 어느 소스가 왜 죽었는지 알 방법이 없어진다.
      const message = describeError(error);
      trendErrorBySource[source] = message;
      console.error(`⚠️ buildDailyQueryPool: trend_candidates(${source}) 조회 실패, 나머지로 진행 -`, message);
    }
  }

  const { entries, mergedCount } = mergeEntries(seedEntries, trendEntries);

  const trendCountBySource: Partial<Record<TrendSource, number>> = {};
  for (const entry of entries) {
    if (!entry.source || !isTrendOrigin(entry.origin)) continue;
    trendCountBySource[entry.source] = (trendCountBySource[entry.source] ?? 0) + 1;
  }
  const trendCount = entries.filter((entry) => isTrendOrigin(entry.origin)).length;

  const firstError = Object.values(trendErrorBySource)[0];

  return {
    entries,
    seedCount: seedEntries.length,
    trendCount,
    trendCountBySource,
    trendMergedCount: mergedCount,
    ...(firstError ? { trendError: firstError } : {}),
    trendErrorBySource,
  };
}
