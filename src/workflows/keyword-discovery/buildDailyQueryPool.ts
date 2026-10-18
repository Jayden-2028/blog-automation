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
   * 변형 접기로 대표만 남긴 그룹. 접기가 꺼져 있거나 접을 그룹이 없으면 빈 배열이다.
   * dailyKeywordWorkflow가 discovery_runs.metadata.queryPoolFold로 저장한다 - 접기는 수집
   * 진입 전에 일어나므로 랭킹 로그만 봐서는 무엇이 사라졌는지 셀 수 없다.
   */
  foldedGroups: QueryPoolFoldGroup[];
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
  /**
   * false면 seed_queries(사람이 등록한 상시 검색어)를 pool에 넣지 않고 동적 소스만으로 구성한다.
   * 오후 커뮤니티 전용 run이 오전 seed 44건을 다시 태우지 않도록 하기 위한 옵션(기본 true).
   */
  includeSeedQueries?: boolean;
  /** 실제 DB insert 없이 merge/fallback을 검증하기 위한 조회 함수 주입 지점. */
  loadActiveSeeds?: () => Promise<SeedQueryRow[]>;
  /** creator_advisor 전용 loader(하위 호환). loadCandidatesBySource보다 우선한다. */
  loadLatestCreatorAdvisorCandidates?: LoadTrendCandidates;
  /** source별 loader 주입. 지정하지 않은 소스는 TrendCandidateRepository를 쓴다. */
  loadCandidatesBySource?: Partial<Record<TrendSource, LoadTrendCandidates>>;
  /**
   * 변형 접기 스위치를 테스트에서만 덮어쓴다(creatorAdvisorEnabled와 같은 성격의 주입 지점).
   * 운영 호출은 이 옵션을 넘기지 않고 env QUERY_POOL_VARIANT_FOLD를 그대로 쓴다.
   */
  variantFoldEnabled?: boolean;
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

// ---------- 변형 키워드 접기 (2026-10-17, QUERY-POOL-VARIANT-FOLD-2026-10.md) ----------
//
// 왜: 10/17 엔터 run 166 Top 10에서 "나솔사계"가 4칸(4·5·6·9위)을 먹었다. Creator Advisor가 같은
// 프로그램의 검색어 변형 13건("나솔사계", "나솔사계 현커", "나솔사계 라방", "나솔사계 최종커플"…)을
// 상위로 올렸고, **변형마다 seedQuery가 달라** selectDiverseTopN의 maxPerSeedQuery=1을 각자
// 통과했다. maxPerCanonicalTopic=1도 못 막았다 - "나솔사계" 토큰이 그날 batch 520건에서 희소
// 기준(df ≤ 11)을 넘어 주제 신호로 인정되지 않았기 때문이다.
//
// 그래서 **수집 진입 전** query pool 단계에서 접는다. 여기서 접으면 NAVER 검색 fan-out도 줄고
// Top N의 칸 수도 자연히 줄어든다. clustering·scoring·relevance·selectDiverseTopN·topicGrouping은
// 한 줄도 건드리지 않는다(CLAUDE.md "승인 없이는 금지" 영역이고, 이 파일의 역할 분리 선언도 그렇다).
//
// trend_candidates 자체는 바꾸지 않는다 - 19시 핫스타가 원본을 그대로 쓰므로 접기는 그날의
// query pool에만 적용된다.

export const QUERY_POOL_VARIANT_FOLD_ENV = "QUERY_POOL_VARIANT_FOLD";

/** 한 변형 그룹에서 pool에 남길 대표 수. */
export const QUERY_POOL_VARIANT_KEEP = 2;

// pipelineGate.ts와 같은 해석 규칙이다: 미설정·빈 값은 켜짐(워크플로가 `vars.X`를 빈 값으로
// 넘기는 경우를 기본값으로 흘리기 위함), 끄는 값만 명시적으로 나열한다.
const FOLD_OFF_VALUES = new Set(["false", "0", "off", "no"]);

/** QUERY_POOL_VARIANT_FOLD 해석. 미설정·빈 값이면 켜짐이고, false/0/off/no면 접기를 생략한다(롤백용). */
export function parseVariantFoldEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return !FOLD_OFF_VALUES.has(normalized);
}

export type QueryPoolFoldGroup = {
  /** 그룹의 base 키워드(토큰이 가장 적은 대표 - 보통 프로그램·인물명 단독). kept[0]과 같다. */
  base: string;
  /** pool에 남긴 대표 키워드(최대 QUERY_POOL_VARIANT_KEEP개). */
  kept: string[];
  /** pool에서 뺀 변형 키워드. */
  dropped: string[];
};

type FoldableEntry = {
  entry: QueryPoolEntry;
  /** entries 배열에서의 원래 위치. 접고 난 뒤 순서를 보존하기 위해 들고 다닌다. */
  index: number;
  tokens: string[];
};

function tokenizeKeyword(keyword: string): string[] {
  return normalizeKeyword(keyword).split(/\s+/).filter(Boolean);
}

/**
 * 같은 주제의 검색어 변형인가. 보수적으로 두 조건을 동시에 요구한다.
 *   ① 첫 토큰이 같다(CA 검색어는 프로그램·인물명이 맨 앞에 오는 형태가 대부분이다).
 *   ② 짧은 쪽의 토큰 집합이 긴 쪽의 부분집합이다.
 *
 * "나솔사계 현커" vs "나솔사계 라방"은 이 판정으로는 직접 묶이지 않는다 - 둘 다 base "나솔사계"와
 * 묶여 **전이적으로만** 한 그룹이 된다. base가 pool에 없으면 형제 변형끼리는 **안 묶인다**.
 * 의도된 보수성이다: 첫 토큰만 같다고 묶으면 "김지원 닥터X"와 "김지원 광고"처럼 서로 다른 이슈를
 * 한 주제로 죽일 수 있다.
 */
function isSameVariantGroup(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a[0] !== b[0]) return false;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerTokens = new Set(longer);
  return shorter.every((token) => longerTokens.has(token));
}

function toRankValue(value: unknown): number {
  const rank = Number(value);
  // rank가 없는 소스(구글 트렌드 등)는 맨 뒤로 보낸다 - "없음"을 1위로 취급하면 안 된다.
  return Number.isFinite(rank) ? rank : Number.POSITIVE_INFINITY;
}

function toScoreValue(value: unknown): number {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

/** base 선정 순서: 토큰 수 오름차순 -> CA rank 오름차순 -> candidateScore 내림차순 -> 키워드 사전순. */
function compareForBase(a: FoldableEntry, b: FoldableEntry): number {
  if (a.tokens.length !== b.tokens.length) return a.tokens.length - b.tokens.length;
  return compareForRank(a, b);
}

/**
 * 2순위 대표 선정 순서: CA rank 오름차순 -> candidateScore 내림차순 -> 키워드 사전순.
 * 마지막 사전순까지 두는 이유는 동률에서 run마다 결과가 흔들리지 않게 하기 위함이다(결정적 선정).
 */
function compareForRank(a: FoldableEntry, b: FoldableEntry): number {
  const rankDiff = toRankValue(a.entry.metadata.rank) - toRankValue(b.entry.metadata.rank);
  if (rankDiff !== 0) return rankDiff;

  const scoreDiff = toScoreValue(b.entry.metadata.candidateScore) - toScoreValue(a.entry.metadata.candidateScore);
  if (scoreDiff !== 0) return scoreDiff;

  return a.entry.keyword.localeCompare(b.entry.keyword, "ko");
}

/**
 * 같은 주제의 검색어 변형을 대표 QUERY_POOL_VARIANT_KEEP개로 접는다.
 *
 * 접기 대상은 **동적 entry(origin=creator_advisor|trend)만**이다. seed와 merged(seed 키워드에
 * 동적 신호가 흡수된 것)는 사람이 큐레이션한 상시 검색어라 접지 않고, 그룹 anchor로도 쓰지 않는다 -
 * 후보 목록에서 아예 빼므로 "seed가 base라서 변형들이 묶이는" 일도 일어나지 않는다.
 *
 * 카테고리는 보지 않는다. mergeEntries가 이미 같은 키워드의 ent/ott 중복을 1 entry로 흡수했고,
 * 접힌 entry의 category·metadata는 대표 것을 그대로 유지한다.
 */
function foldVariantQueries(
  entries: QueryPoolEntry[],
  options: { enabled: boolean }
): { entries: QueryPoolEntry[]; foldedGroups: QueryPoolFoldGroup[] } {
  if (!options.enabled) return { entries, foldedGroups: [] };

  const foldable: FoldableEntry[] = [];
  entries.forEach((entry, index) => {
    if (!isTrendOrigin(entry.origin)) return;
    const tokens = tokenizeKeyword(entry.keyword);
    if (tokens.length === 0) return;
    foldable.push({ entry, index, tokens });
  });

  // union-find. 쌍 판정이 전이성을 보장하지 않으므로(현커-라방은 base를 거쳐야 한다) 묶기는
  // 집합 연산으로 한다. 동적 entry는 하루 최대 수십 건이라 O(n^2) 쌍 비교로 충분하다.
  const parent = foldable.map((_, index) => index);
  const find = (index: number): number => {
    let node = index;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < foldable.length; i++) {
    for (let j = i + 1; j < foldable.length; j++) {
      if (isSameVariantGroup(foldable[i].tokens, foldable[j].tokens)) union(i, j);
    }
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < foldable.length; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(i);
    else buckets.set(root, [i]);
  }

  const droppedIndexes = new Set<number>();
  const foldedGroups: QueryPoolFoldGroup[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length <= QUERY_POOL_VARIANT_KEEP) continue;

    const byBase = [...bucket].sort((a, b) => compareForBase(foldable[a], foldable[b]));
    const base = byBase[0];
    const rest = byBase.slice(1).sort((a, b) => compareForRank(foldable[a], foldable[b]));

    const keptIndexes = [base, ...rest.slice(0, QUERY_POOL_VARIANT_KEEP - 1)];
    const droppedList = rest.slice(QUERY_POOL_VARIANT_KEEP - 1);
    for (const item of droppedList) droppedIndexes.add(foldable[item].index);

    const group: QueryPoolFoldGroup = {
      base: foldable[base].entry.keyword,
      kept: keptIndexes.map((item) => foldable[item].entry.keyword),
      dropped: droppedList.map((item) => foldable[item].entry.keyword),
    };
    foldedGroups.push(group);

    console.log(
      `ℹ️ [buildDailyQueryPool] 변형 접기: ${group.base} (${bucket.length}→${group.kept.length}) — ` +
        `대표 [${group.kept.join(", ")}], 접힘 [${group.dropped.join(", ")}]`
    );
  }

  if (droppedIndexes.size === 0) return { entries, foldedGroups };
  return { entries: entries.filter((_, index) => !droppedIndexes.has(index)), foldedGroups };
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
  const includeSeedQueries = options.includeSeedQueries ?? true;
  const loadActiveSeeds = options.loadActiveSeeds ?? (() => SeedQueryRepository.getActiveSeeds());

  const activeSeeds = includeSeedQueries ? await loadActiveSeeds() : [];
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

  const { entries: mergedEntries, mergedCount } = mergeEntries(seedEntries, trendEntries);

  // 접기는 merge가 끝난 뒤에 돈다. seed와 흡수분(origin="merged")이 먼저 확정돼야
  // "사람이 큐레이션한 것은 접지 않는다"를 지킬 수 있다.
  const { entries, foldedGroups } = foldVariantQueries(mergedEntries, {
    enabled:
      options.variantFoldEnabled ?? parseVariantFoldEnabled(process.env[QUERY_POOL_VARIANT_FOLD_ENV]),
  });

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
    foldedGroups,
    ...(firstError ? { trendError: firstError } : {}),
    trendErrorBySource,
  };
}
