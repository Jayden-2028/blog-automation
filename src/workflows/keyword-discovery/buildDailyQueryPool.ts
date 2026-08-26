// daily query pool 조립: seed_queries(stable/base) + trend_candidates(dynamic, Creator Advisor)를
// normalize/dedupe해서 하나의 query 목록으로 합친다.
//
// 역할 분리(중요): Creator Advisor 데이터는 seed_queries에 직접 영구 등록하지 않는다.
// - seed_queries: 장기적으로 유지되는 stable/base 검색어(사람이 직접 큐레이션).
// - trend_candidates: Creator Advisor 등에서 매일 생성되는 dynamic 검색 후보.
// 이 함수는 매 호출마다 두 소스를 즉석에서 merge할 뿐, trend_candidates의 내용을 seed_queries로
// 승격시키지 않는다.
//
// 주의(요구사항 #10): 이 파일은 query 목록을 "누가 조회할지" 조립만 할 뿐, 이후 단계인
// keyword-discovery(수집)/keyword-ranking(clustering/scoring)의 로직에는 관여하지 않는다.
// collectNaverCandidates/scoreKeyword/CompositeSimilarityClusterer 등은 이 파일이 만든
// queries 배열을 기존과 동일한 형태(string[])로 그대로 받는다.
//
// fallback 보장(요구사항 #7): CREATOR_ADVISOR_CONFIG.enabled가 false이거나 trend_candidates 조회가
// 실패해도(로그인 실패/not ready/browser error/timeout/7일간 available 날짜 없음 등 사유 무관) 이
// 함수는 예외를 던지지 않고 seed_queries만으로 구성된 결과를 반환한다 - 그래서 dailyKeywordWorkflow.ts의
// "seed" 단계는 이 함수 하나만 호출하면 되고, Creator Advisor 유무에 따라 별도 분기를 두지 않아도 된다.
// Creator Advisor는 seed_queries 파이프라인을 보강하는 enrichment source일 뿐, 필수 의존성이 아니다.

import { CREATOR_ADVISOR_CONFIG } from "../../config/creatorAdvisor.js";
import { SeedQueryRepository } from "../../repositories/SeedQueryRepository.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { selectTopCreatorAdvisorCandidates } from "../creator-advisor/selectTopCreatorAdvisorCandidates.js";
import type { SeedQueryRow, TrendCandidateRow } from "../../types/database.js";

export type QueryPoolOrigin = "seed" | "creator_advisor" | "merged";

export type QueryPoolEntry = {
  keyword: string;
  category: string;
  /** 대표 seedQuery 동률 판정 등에 쓰이는 운영 priority. seed는 seed_queries.priority, CA는 고정값. */
  priority: number;
  origin: QueryPoolOrigin;
  /**
   * Creator Advisor 유래 신호(topic 원본/trendDate/movementType/rank/rankChange/candidateScore)를
   * 담는다. origin="seed"면 빈 객체. origin="merged"면 metadata.creatorAdvisor에 CA 쪽 신호가
   * 보존된다(요구사항: "Creator Advisor signal은 metadata로 잃지 않도록").
   */
  metadata: Record<string, unknown>;
};

export type BuildDailyQueryPoolResult = {
  entries: QueryPoolEntry[];
  seedCount: number;
  /** Daily Query Pool에 새로 추가된 Creator Advisor 전용 entry 수(merge로 흡수된 것은 제외). */
  trendCount: number;
  /** seed_queries와 keyword가 겹쳐 origin="merged"로 흡수된 Creator Advisor 후보 수. */
  trendMergedCount: number;
  /** trend_candidates 조회가 실패했을 때만 채워진다. 실패해도 entries는 seed만으로 채워져 반환된다. */
  trendError?: string;
};

export type BuildDailyQueryPoolOptions = {
  /** 테스트/로컬 검증에서만 설정을 덮어쓴다. 운영 호출은 config의 enabled 값을 그대로 쓴다. */
  creatorAdvisorEnabled?: boolean;
  /** 실제 DB insert 없이 merge/fallback을 검증하기 위한 조회 함수 주입 지점. */
  loadActiveSeeds?: () => Promise<SeedQueryRow[]>;
  loadLatestCreatorAdvisorCandidates?: () => Promise<{
    trendDate: string | null;
    candidates: TrendCandidateRow[];
  }>;
};

// Creator Advisor 기반 entry의 기본 priority. seed_queries 기본값(5)보다 낮게 둬서, 같은 우선순위
// 동률 상황에서는 사람이 직접 큐레이션한 seed가 우선하도록 한다. scoring/ranking 로직 자체는
// 건드리지 않는다 - aggregateClusterSignals가 대표 seedQuery를 고를 때 참고하는 값일 뿐이다.
const CREATOR_ADVISOR_QUERY_PRIORITY = 3;

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function buildSeedEntry(seed: SeedQueryRow): QueryPoolEntry {
  return {
    keyword: seed.keyword,
    category: seed.category,
    priority: seed.priority,
    origin: "seed",
    metadata: {},
  };
}

/** trend_candidates row 하나 -> QueryPoolEntry. category는 topic_normalized(내부 category mapping 결과)를 쓴다. */
function buildCreatorAdvisorEntry(row: TrendCandidateRow): QueryPoolEntry {
  return {
    keyword: row.keyword,
    category: row.topic_normalized,
    priority: CREATOR_ADVISOR_QUERY_PRIORITY,
    origin: "creator_advisor",
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

// keyword(trim+lowercase) 기준으로 seed/Creator Advisor 후보를 merge한다. 같은 keyword가 양쪽에
// 있으면 seed를 primary로 유지하되(요구사항: "중복 keyword가 있으면 stable seed를 우선"),
// Creator Advisor signal은 잃지 않도록 origin을 "merged"로 표시하고 metadata.creatorAdvisor에
// CA entry의 metadata를 그대로 보존한다.
function mergeEntries(
  seedEntries: QueryPoolEntry[],
  creatorAdvisorEntries: QueryPoolEntry[]
): { entries: QueryPoolEntry[]; mergedCount: number } {
  const byKeyword = new Map<string, QueryPoolEntry>();
  for (const entry of seedEntries) {
    byKeyword.set(normalizeKeyword(entry.keyword), entry);
  }

  let mergedCount = 0;
  for (const caEntry of creatorAdvisorEntries) {
    const key = normalizeKeyword(caEntry.keyword);
    const existing = byKeyword.get(key);

    if (existing?.origin === "seed" || existing?.origin === "merged") {
      mergedCount++;
      byKeyword.set(key, {
        ...existing,
        origin: "merged",
        metadata: { ...existing.metadata, creatorAdvisor: caEntry.metadata },
      });
    } else if (existing?.origin === "creator_advisor") {
      // 같은 CA keyword가 서로 다른 topic row로 존재할 수 있다(unique key에 topic이 포함됨).
      // 이 경우 seed와 합쳐진 것이 아니므로 origin/mergedCount를 바꾸지 않고 더 높은 pre-score를 남긴다.
      const existingScore = Number(existing.metadata.candidateScore ?? 0);
      const nextScore = Number(caEntry.metadata.candidateScore ?? 0);
      if (nextScore > existingScore) byKeyword.set(key, caEntry);
    } else {
      byKeyword.set(key, caEntry);
    }
  }

  return { entries: [...byKeyword.values()], mergedCount };
}

export async function buildDailyQueryPool(
  options: BuildDailyQueryPoolOptions = {}
): Promise<BuildDailyQueryPoolResult> {
  const loadActiveSeeds = options.loadActiveSeeds ?? (() => SeedQueryRepository.getActiveSeeds());
  const loadLatestCreatorAdvisorCandidates =
    options.loadLatestCreatorAdvisorCandidates ??
    (() => TrendCandidateRepository.listLatestActiveCandidates("creator_advisor"));

  const activeSeeds = await loadActiveSeeds();
  const seedEntries = activeSeeds.map(buildSeedEntry);

  const creatorAdvisorEnabled = options.creatorAdvisorEnabled ?? CREATOR_ADVISOR_CONFIG.enabled;
  if (!creatorAdvisorEnabled) {
    return { entries: seedEntries, seedCount: seedEntries.length, trendCount: 0, trendMergedCount: 0 };
  }

  try {
    // latestAvailableTrendDate의 active Creator Advisor 후보만 사용한다(오늘/어제로 날짜를
    // 고정하지 않는다 - trendDateNavigation.ts가 이미 "최신 날짜에 데이터가 없으면 하루씩
    // 되돌아가 찾은 날짜"를 trend_date로 저장해뒀으므로, 여기서는 그 값을 그대로 신뢰한다).
    const { candidates } = await loadLatestCreatorAdvisorCandidates();

    // Daily Query Pool에는 전체(최대 120개 안팎)를 다 넣지 않고, candidate_score + topic diversity
    // 기준으로 상위 일부(기본 40개, topic당 최대 6개)만 선별한다.
    const scoredCandidates = candidates.map((row) => ({ ...row, candidateScore: row.candidate_score ?? 0 }));
    const selected = selectTopCreatorAdvisorCandidates(scoredCandidates);
    const creatorAdvisorEntries = selected.map(buildCreatorAdvisorEntry);

    const { entries, mergedCount } = mergeEntries(seedEntries, creatorAdvisorEntries);
    const trendCount = entries.filter((entry) => entry.origin === "creator_advisor").length;

    return {
      entries,
      seedCount: seedEntries.length,
      trendCount,
      trendMergedCount: mergedCount,
    };
  } catch (error) {
    // Creator Advisor(trend_candidates) 조회 실패 - 로그인 실패/not ready/browser error/timeout/
    // 7일간 available 날짜 없음 등 사유가 무엇이든 daily workflow 전체를 막지 않는다(요구사항 #7).
    // seed_queries만으로 정상 진행하고, 실패 사유는 trendError로만 남겨 호출자가 로깅/모니터링할 수 있게 한다.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "⚠️ buildDailyQueryPool: Creator Advisor(trend_candidates) 조회 실패, seed_queries만으로 진행 -",
      message
    );
    return {
      entries: seedEntries,
      seedCount: seedEntries.length,
      trendCount: 0,
      trendMergedCount: 0,
      trendError: message,
    };
  }
}
