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

import { TOPIC_GROUPING_CONFIG } from "../../config/keywordScoring.js";
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
   * 정규화된 키워드 -> 그날 그 키워드가 올라온 **원본 topic 카드 제목** 목록(2026-11-11).
   * quota 선별·merge·접기 **이전**의 전체 동적 후보에서 모은다 - 선별 후에는 비엔터 행이 떨어져
   * "같은 키워드가 여러 분야 카드에 동시에 올라왔다"는 증거가 사라진다.
   * 엔터 topic 충돌 판정(entertainmentTopicConflict.ts)이 이 값을 읽는다. 동적 소스가 없으면 빈 객체다.
   */
  topicsByKeyword: Record<string, string[]>;
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
  /**
   * 문자 bigram 접기(3단계) 스위치를 테스트에서만 덮어쓴다. 운영 호출은 이 옵션을 넘기지 않고
   * env QUERY_POOL_FOLD_CHARGRAM(기본 꺼짐)을 그대로 쓴다.
   */
  charGramFoldEnabled?: boolean;
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

/**
 * 어순 변형만 다른 그룹(토큰 집합이 완전히 같음)에서 남길 대표 수. 2026-10-21 추가.
 *
 * 왜 1인가: run 182에서 시드 "이재 샘킴 결혼"과 "샘킴 이재 결혼"이 각각 살아 같은 주제가 [2]+[4]
 * 두 칸을 먹었다. 첫 토큰이 달라 기존 판정(첫 토큰 동일 + 부분집합)에 걸리지 않았다. 토큰이 같으면
 * **검색 결과도 사실상 같으므로** 2개를 남길 이유가 없다.
 */
export const QUERY_POOL_WORD_ORDER_KEEP = 1;

// pipelineGate.ts와 같은 해석 규칙이다: 미설정·빈 값은 켜짐(워크플로가 `vars.X`를 빈 값으로
// 넘기는 경우를 기본값으로 흘리기 위함), 끄는 값만 명시적으로 나열한다.
const FOLD_OFF_VALUES = new Set(["false", "0", "off", "no"]);

/** QUERY_POOL_VARIANT_FOLD 해석. 미설정·빈 값이면 켜짐이고, false/0/off/no면 접기를 생략한다(롤백용). */
export function parseVariantFoldEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return !FOLD_OFF_VALUES.has(normalized);
}

// ---------- 3단계: 문자 bigram 접기 (2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R3) ----------
//
// 왜: 위 두 단계는 **공백으로 자른 토큰**을 본다. 그래서 2026-11-10 run 260에서 한 사안이 Top 10의
// 3칸을 먹는 동안 접힌 그룹이 하나뿐이었다. 토큰 판정이 원리적으로 못 보는 세 가지가 있다.
//   ① 띄어쓰기 차이: `젠슨황`(1토큰) vs `젠슨 황 불륜`(3토큰) — isSameVariantGroup이 첫 토큰
//      (`젠슨황` vs `젠슨`)부터 다르다고 보고 그룹을 만들지 않는다.
//   ② 한 글자 표기 차이: `앨리스황` vs `엘리스황` — 각각 1토큰 단독이고 문자열이 달라 교집합이 0이다.
//   ③ 2개짜리 그룹: `젠슨 황 불륜` + `젠슨 황 불륜 인정`은 같은 그룹이 되지만 2단계의
//      `bucket.length <= QUERY_POOL_VARIANT_KEEP`(=2) 조기 반환에 걸려 **영원히 접히지 않는다.**
//
// 그래서 **공백을 지운 문자 bigram**으로 한 번 더 묶는다. 위 세 경우가 전부 접힌다.
//   젠슨황 {젠슨,슨황} ⊂ 젠슨황불륜 {젠슨,슨황,황불,불륜}      -> 부분집합
//   앨리스황 {앨리,리스,스황} vs 엘리스황 {엘리,리스,스황}       -> 자카드 0.5
//
// 과접기를 막는 가드 넷:
//   ㉠ 자카드 경로는 교집합 2개 이상을 요구한다(1개 우연 일치 금지).
//   ㉡ bigram이 2개 미만인 키워드(공백 제거 후 3글자 미만)는 아예 대상에서 뺀다.
//   ㉢ **부분집합 경로는 작은 쪽 bigram이 3개 이상**이어야 한다(2026-11-11 교정, 아래).
//   ㉣ **분류어·범용어와 글자까지 같은 키워드는 대상에서 뺀다**(2026-11-11 교정, 아래).
// 이 가드로 `김지원 닥터X` vs `김지원 광고`는 자카드 0.29로 **묶이지 않는다**(2단계 주석이 적어 둔
// "서로 다른 이슈를 한 주제로 죽이지 않는다"는 보수성을 그대로 지킨다).
//
// ---------- 2026-11-11 교정: 짧은 일반어가 구체적인 키워드를 삼키던 문제 ----------
//
// 첫 구현의 부분집합 경로는 "작은 쪽 bigram이 전부 큰 쪽에 있다"만 요구했다. 한국어에서 그건 사실상
// **부분문자열 포함**이라, 짧은 일반어가 아무 긴 키워드나 삼킨다. 실측 재현:
//   아이돌 {아이,이돌} ⊂ 이세계아이돌 {이세,세계,계아,아이,이돌}
//   -> 한 그룹, charGramKeepCount(2)=1, **살아남는 쪽이 `아이돌`**(토큰 수가 적어 base다).
// 구체적인 이슈 키워드를 버리고 분류어를 남기는 셈이고, PR #66에서 1등 키워드를 잃은 것과 같은
// 계열의 손실이다. 2단계는 **첫 토큰이 같을 것**을 요구해 면역이었는데 여기엔 그 앵커가 없었다.
//
// ㉢을 "전역 최소 크기를 3으로 올린다"로 하지 **않은** 이유: `젠슨황`은 공백을 지워도 3글자(bigram
// 2개)라, 전역으로 올리면 이 단계를 만든 1순위 목적(`젠슨황`↔`젠슨 황 불륜`)이 먼저 죽는다.
// 그래서 **부분집합 경로에만** 3개를 요구하고, 자카드 경로는 2개를 그대로 둔다. 그러면
//   젠슨황(2) vs 젠슨황불륜(4)  — 자카드 2/4 = 0.50 >= 0.5  -> 묶인다 ✅ (의도)
//   아이돌(2) vs 이세계아이돌(5) — 자카드 2/5 = 0.40 <  0.5  -> 안 묶인다 ✅ (교정)
// 로 갈린다. 자카드 0.5는 "긴 쪽이 짧은 쪽의 2배를 넘지 않는다"는 뜻이라, 3글자 키워드가 임의로
// 긴 문자열에 삼켜지는 길이 막힌다 - 길이 상한이 판정 안에 들어 있는 셈이다.
//
// ㉣은 의도를 직접 말하는 겹이다. `드라마`·`영화`·`방송`·`연예`처럼 TOPIC_GROUPING_CONFIG가 이미
// "주제가 아니라 분류"로 선언해 둔 말이 동적 소스에서 단독 키워드로 올라오면 접기 앵커가 되지
// 못하게 한다. 두 겹을 함께 두는 이유: ㉣만 두면 목록에 없는 짧은 일반어(`아이돌`이 그렇다)가
// 그대로 통과하고, ㉢만 두면 `넷플릭스`처럼 긴 분류어가 남는다.
//
// 2·1단계는 **한 줄도 바꾸지 않았다.** 이 단계는 그 결과(survivors) 위에 덧붙어 돌고, 게이트가
// 꺼져 있으면 아예 실행되지 않는다 - 끄면 동작이 2026-11-10과 완전히 같다.

export const QUERY_POOL_FOLD_CHARGRAM_ENV = "QUERY_POOL_FOLD_CHARGRAM";

/** 문자 bigram 자카드 임계값. `앨리스황`↔`엘리스황`(0.5)이 통과하는 지점이다. */
export const QUERY_POOL_CHARGRAM_THRESHOLD = 0.5;

/** 자카드 경로가 요구하는 최소 bigram 교집합 수. 1개 우연 일치로 묶이는 것을 막는다. */
export const QUERY_POOL_CHARGRAM_MIN_INTERSECTION = 2;

/** 이 수보다 bigram이 적은 키워드는 판정 대상에서 뺀다(= 공백 제거 후 3글자 미만). */
export const QUERY_POOL_CHARGRAM_MIN_SIZE = 2;

/**
 * **부분집합 경로**가 요구하는 작은 쪽 최소 bigram 수(2026-11-11 교정). 전역 최소 크기를 올리는
 * 대신 이 경로에만 걸어, `젠슨황`(bigram 2개)이 자카드 경로로는 계속 묶이게 둔다 - 근거는 위 주석.
 */
export const QUERY_POOL_CHARGRAM_SUBSET_MIN_SIZE = 3;

/**
 * 접기 앵커가 되지 못하게 뺄 분류어·범용어. topicGrouping과 **같은 목록**을 쓴다 - 두 경로의
 * 기준이 어긋나면 "여기선 주제인데 저기선 분류어"가 생긴다. 글자까지 같은 키워드만 뺀다
 * (`아이돌 그룹`처럼 분류어를 포함하는 구는 그대로 둔다 - 그건 주제를 가리킬 수 있다).
 */
const CHARGRAM_EXCLUDED_KEYWORDS = new Set(
  [...TOPIC_GROUPING_CONFIG.categoryTerms, ...TOPIC_GROUPING_CONFIG.genericTokens].map((term) =>
    term.trim().toLowerCase().replace(/\s+/g, "")
  )
);

/** 이 키워드가 분류어·범용어와 글자까지 같은가(공백 무시). 같으면 접기 대상에서 뺀다. */
export function isCharGramExcludedKeyword(keyword: string): boolean {
  return CHARGRAM_EXCLUDED_KEYWORDS.has(keyword.trim().toLowerCase().replace(/\s+/g, ""));
}

/**
 * 문자 bigram 그룹에서 남길 대표 수. **그룹 크기가 정한다**(설계안 R3 (ii)안).
 *
 * 왜 고정값이 아닌가: 10/17 나솔사계처럼 변형이 13개 쏟아지는 프로그램 키워드는 대표 2개가 유용했고
 * (QUERY_POOL_VARIANT_KEEP의 근거), 11/10 젠슨 황처럼 2~3개로 갈라진 인물 표기는 1개면 충분했다.
 * 같은 상수로 둘을 만족시킬 수 없으므로 크기로 가른다.
 */
export function charGramKeepCount(groupSize: number): number {
  return groupSize >= 4 ? 2 : 1;
}

/** QUERY_POOL_FOLD_CHARGRAM 해석. **미설정·빈 값이면 꺼짐**(승인 전 preview 단계이므로 기본이 off다). */
export function parseCharGramFoldEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/** 공백을 모두 지운 소문자 문자열의 bigram 집합. */
export function charBigrams(keyword: string): Set<string> {
  const compact = keyword.toLowerCase().replace(/\s+/g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= compact.length; i++) grams.add(compact.slice(i, i + 2));
  return grams;
}

function intersectionCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) count++;
  }
  return count;
}

/** 두 키워드가 같은 사안의 표기 변형인가(문자 bigram 기준). 가드는 이 파일 상단 주석 참고. */
export function isSameCharGramGroup(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size < QUERY_POOL_CHARGRAM_MIN_SIZE || b.size < QUERY_POOL_CHARGRAM_MIN_SIZE) return false;

  const shared = intersectionCount(a, b);
  if (shared === 0) return false;

  const [smaller] = a.size <= b.size ? [a, b] : [b, a];
  // 부분집합 경로. 작은 쪽이 너무 짧으면 쓰지 않는다 - 한국어에서 그건 부분문자열 포함이라
  // 짧은 일반어가 아무 긴 키워드나 삼킨다(파일 상단 2026-11-11 교정).
  if (shared === smaller.size && smaller.size >= QUERY_POOL_CHARGRAM_SUBSET_MIN_SIZE) return true;

  if (shared < QUERY_POOL_CHARGRAM_MIN_INTERSECTION) return false;
  const union = a.size + b.size - shared;
  return shared / union >= QUERY_POOL_CHARGRAM_THRESHOLD;
}

export type QueryPoolFoldGroup = {
  /** 그룹의 base 키워드(토큰이 가장 적은 대표 - 보통 프로그램·인물명 단독). kept[0]과 같다. */
  base: string;
  /** pool에 남긴 대표 키워드(최대 QUERY_POOL_VARIANT_KEEP개). */
  kept: string[];
  /** pool에서 뺀 변형 키워드. */
  dropped: string[];
  /**
   * 그룹 종류(2026-10-21 추가 필드. 기존 base·kept·dropped 모양은 그대로다).
   *   "subset"    — 첫 토큰 동일 + 토큰 부분집합. 대표 2개를 남긴다.
   *   "wordOrder" — 토큰 집합이 완전히 같고 순서만 다름. 대표 1개만 남긴다.
   *   "charGram"  — 공백을 지운 문자 bigram이 겹침(2026-11-11, QUERY_POOL_FOLD_CHARGRAM).
   *                 띄어쓰기·한 글자 표기 차이를 잡는다. 대표 수는 그룹 크기가 정한다.
   */
  kind: "subset" | "wordOrder" | "charGram";
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
 * 토큰 집합이 완전히 같은가(순서만 다름). "이재 샘킴 결혼" ↔ "샘킴 이재 결혼".
 * 중복 토큰은 집합으로 보므로 무시한다 - 검색어에서 같은 낱말을 두 번 쓰는 경우는 사실상 없다.
 */
function isWordOrderVariant(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const token of setA) {
    if (!setB.has(token)) return false;
  }
  return true;
}

/**
 * 같은 주제의 검색어 변형인가. 보수적으로 두 조건을 동시에 요구한다.
 *   ① 첫 토큰이 같다(CA 검색어는 프로그램·인물명이 맨 앞에 오는 형태가 대부분이다).
 *   ② 짧은 쪽의 토큰 집합이 긴 쪽의 부분집합이다.
 *
 * 어순 변형(토큰 집합이 같고 순서만 다름)은 이 판정이 아니라 **앞 단계**(foldWordOrderVariants)가
 * 먼저 1개로 줄인다 - 여기서 함께 묶으면 "어순 쌍 + 부분집합 변형"이 한 그룹이 되어 KEEP=2에
 * 어순 쌍 둘이 그대로 남을 수 있다(실측 반례: 이재 샘킴 결혼 / 샘킴 이재 결혼 / 이재 샘킴 결혼 축하).
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
 * 1단계 — 어순 변형 묶기(2026-10-21). 토큰 집합이 같은 것들을 **대표 1개**로 줄인다.
 * 대표는 CA rank 상위(compareForBase는 토큰 수가 같으면 rank로 떨어진다).
 *
 * 부분집합 접기보다 **먼저** 도는 이유: 나중에 돌리면 어순 쌍이 부분집합 그룹에 섞여 들어가
 * KEEP=2 자리를 어순 쌍 둘이 차지할 수 있다(이재 샘킴 결혼 / 샘킴 이재 결혼 / 이재 샘킴 결혼 축하).
 */
function foldWordOrderVariants(
  foldable: readonly FoldableEntry[]
): { survivors: FoldableEntry[]; droppedIndexes: Set<number>; groups: QueryPoolFoldGroup[] } {
  const buckets = new Map<string, FoldableEntry[]>();
  for (const item of foldable) {
    const key = [...new Set(item.tokens)].sort().join("\u0000");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const droppedIndexes = new Set<number>();
  const groups: QueryPoolFoldGroup[] = [];
  const survivors: FoldableEntry[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length <= QUERY_POOL_WORD_ORDER_KEEP) {
      survivors.push(...bucket);
      continue;
    }

    const ordered = [...bucket].sort(compareForBase);
    const kept = ordered.slice(0, QUERY_POOL_WORD_ORDER_KEEP);
    const dropped = ordered.slice(QUERY_POOL_WORD_ORDER_KEEP);

    survivors.push(...kept);
    for (const item of dropped) droppedIndexes.add(item.index);

    const group: QueryPoolFoldGroup = {
      base: kept[0].entry.keyword,
      kept: kept.map((item) => item.entry.keyword),
      dropped: dropped.map((item) => item.entry.keyword),
      kind: "wordOrder",
    };
    groups.push(group);

    console.log(
      `ℹ️ [buildDailyQueryPool] 어순 변형 접기: ${group.base} (${bucket.length}→${group.kept.length}) — ` +
        `대표 [${group.kept.join(", ")}], 접힘 [${group.dropped.join(", ")}]`
    );
  }

  // 원래 순서를 유지한다(entries 필터링은 index로 하지만, 이후 단계의 쌍 비교 순서도 결정적이어야 한다).
  survivors.sort((a, b) => a.index - b.index);
  return { survivors, droppedIndexes, groups };
}

/**
 * 2단계 — 같은 주제의 검색어 변형을 대표 QUERY_POOL_VARIANT_KEEP개로 접는다.
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
  options: { enabled: boolean; charGramEnabled: boolean }
): { entries: QueryPoolEntry[]; foldedGroups: QueryPoolFoldGroup[] } {
  if (!options.enabled) return { entries, foldedGroups: [] };

  const allFoldable: FoldableEntry[] = [];
  entries.forEach((entry, index) => {
    if (!isTrendOrigin(entry.origin)) return;
    const tokens = tokenizeKeyword(entry.keyword);
    if (tokens.length === 0) return;
    allFoldable.push({ entry, index, tokens });
  });

  // 1단계: 어순 변형을 먼저 1개로 줄인다. 그 결과만 2단계(부분집합)로 넘긴다.
  const wordOrder = foldWordOrderVariants(allFoldable);
  const foldable = wordOrder.survivors;

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

  const droppedIndexes = new Set<number>(wordOrder.droppedIndexes);
  const foldedGroups: QueryPoolFoldGroup[] = [...wordOrder.groups];

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
      kind: "subset",
    };
    foldedGroups.push(group);

    console.log(
      `ℹ️ [buildDailyQueryPool] 변형 접기: ${group.base} (${bucket.length}→${group.kept.length}) — ` +
        `대표 [${group.kept.join(", ")}], 접힘 [${group.dropped.join(", ")}]`
    );
  }

  // 3단계: 문자 bigram 접기(게이트 뒤).
  //
  // 입력은 1·2단계 **이전**의 전체 동적 entry다(survivors가 아니다). 대표 수를 그룹 크기가 정하므로
  // (charGramKeepCount) 앞 단계가 이미 줄여 놓은 목록을 보면 크기를 잘못 센다 - 실측 반례:
  // 나솔사계 변형 5건은 2단계가 2건으로 줄이는데, 그 2건만 보면 "크기 2 → 대표 1"이 되어
  // 10/17에 KEEP=2로 정한 전례가 조용히 무너진다. 전체를 보면 "크기 5 → 대표 2"로 보존된다.
  // 이 단계는 **접힘만 더한다**(앞 단계가 접은 것을 되살리지 않는다). 끄면 droppedIndexes와
  // foldedGroups가 위에서 만들어진 그대로여서 동작이 기존과 완전히 같다.
  if (options.charGramEnabled) {
    const charGram = foldCharGramVariants(allFoldable, droppedIndexes);
    for (const index of charGram.droppedIndexes) droppedIndexes.add(index);
    foldedGroups.push(...charGram.groups);
  }

  if (droppedIndexes.size === 0) return { entries, foldedGroups };
  return { entries: entries.filter((_, index) => !droppedIndexes.has(index)), foldedGroups };
}

/**
 * 3단계 — 공백을 지운 문자 bigram으로 같은 사안의 표기 변형을 묶고, 그룹 크기별 대표만 남긴다.
 * 판정 규칙과 과접기 가드는 isSameCharGramGroup 위 주석에 있다.
 *
 * 대표 선정 순서는 2단계와 같다(토큰 수 적은 것 -> CA rank -> candidateScore -> 사전순) -
 * 같은 사안이면 **짧은 쪽이 검색 커버리지가 넓기** 때문이고, 동률에서 run마다 결과가 흔들리지
 * 않도록 마지막에 사전순을 둔다.
 *
 * **대표는 앞 단계가 접지 않은 멤버 중에서 고른다**(2026-11-11 교정). 그러지 않으면 두 단계가
 * 서로의 대표를 떨어뜨린다 - 2단계는 2순위 대표를 compareForRank(rank 우선)로 고르고 이 단계는
 * 가족 전체를 compareForBase(토큰 수 우선)로 정렬하므로, 둘이 고르는 2순위가 다를 수 있다.
 * 실측 반례(게이트 켠 상태):
 *   입력 젠슨황(1토큰 rank9) / 젠슨황 와이프(2토큰 rank5) / 젠슨황 와이프 논란(3토큰 rank1) / 젠슨 황 불륜(rank2)
 *   2단계 대표 [젠슨황, 젠슨황 와이프 논란]  접힘 [젠슨황 와이프]
 *   3단계 대표 [젠슨황, 젠슨황 와이프]       접힘 [젠슨황 와이프 논란, 젠슨 황 불륜]
 *   -> 합쳐서 4건 중 3건이 접혀 **1건만 남는다**(charGramKeepCount(4)는 2인데).
 * 게다가 metadata.queryPoolFold의 kept에 **풀에 없는 키워드**(젠슨황 와이프)가 적혀, 1주 preview로
 * 적용 여부를 판단할 숫자가 양방향으로 틀어진다.
 *
 * keepCount는 계속 **전체 그룹 크기**로 계산한다 - 10/17 나솔사계의 KEEP=2 전례를 지키려면
 * 앞 단계가 줄여 놓은 수가 아니라 가족의 실제 크기를 봐야 한다(이 함수 호출부 주석).
 */
function foldCharGramVariants(
  foldable: readonly FoldableEntry[],
  alreadyDropped: ReadonlySet<number>
): { droppedIndexes: Set<number>; groups: QueryPoolFoldGroup[] } {
  const droppedIndexes = new Set<number>();
  const groups: QueryPoolFoldGroup[] = [];

  const targets = foldable
    .filter((item) => !isCharGramExcludedKeyword(item.entry.keyword))
    .map((item) => ({ item, grams: charBigrams(item.entry.keyword) }))
    .filter((candidate) => candidate.grams.size >= QUERY_POOL_CHARGRAM_MIN_SIZE);
  if (targets.length < 2) return { droppedIndexes, groups };

  // union-find. 쌍 판정에 전이성이 없으므로(`젠슨황`-`젠슨황불륜`-`젠슨황불륜인정`은 사슬로 이어진다)
  // 묶기는 집합 연산으로 한다. 동적 entry는 하루 수십 건이라 O(n^2)로 충분하다(2단계와 같은 전제).
  const parent = targets.map((_, index) => index);
  const find = (index: number): number => {
    let node = index;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      if (!isSameCharGramGroup(targets[i].grams, targets[j].grams)) continue;
      const rootA = find(i);
      const rootB = find(j);
      if (rootA !== rootB) parent[rootB] = rootA;
    }
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < targets.length; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(i);
    else buckets.set(root, [i]);
  }

  for (const bucket of buckets.values()) {
    const keepCount = charGramKeepCount(bucket.length);
    if (bucket.length <= keepCount) continue;

    // 앞 단계가 이미 접은 멤버는 대표 후보에서 **빼고** 고른다(함수 주석의 실측 반례).
    // 그러면 이 단계가 새로 접는 것은 "살아 있는 멤버 중 대표 밖"뿐이고, 앞 단계가 접은 것을
    // 다시 세지도 않는다 - metadata.queryPoolFold의 droppedCount 이중 집계와, 앞 단계와 결과가
    // 같은 그룹(실측: 나솔사계)이 목록에 중복으로 들어가는 문제도 함께 사라진다.
    const available = [...bucket]
      .filter((index) => !alreadyDropped.has(targets[index].item.index))
      .sort((a, b) => compareForBase(targets[a].item, targets[b].item));
    const keptIndexes = available.slice(0, keepCount);
    const newlyDropped = available.slice(keepCount);
    if (newlyDropped.length === 0) continue;

    for (const index of newlyDropped) droppedIndexes.add(targets[index].item.index);

    const group: QueryPoolFoldGroup = {
      base: targets[keptIndexes[0]].item.entry.keyword,
      kept: keptIndexes.map((index) => targets[index].item.entry.keyword),
      dropped: newlyDropped.map((index) => targets[index].item.entry.keyword),
      kind: "charGram",
    };
    groups.push(group);

    console.log(
      `ℹ️ [buildDailyQueryPool] 문자 bigram 접기: ${group.base} (그룹 ${bucket.length}건 → 대표 ${group.kept.length}건) — ` +
        `대표 [${group.kept.join(", ")}], 이 단계에서 접힘 [${group.dropped.join(", ")}]`
    );
  }

  return { droppedIndexes, groups };
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
  // 정규화 키워드 -> 그날 올라온 원본 topic 카드 제목. **quota 선별 전**에 모은다(선별이 비엔터
  // 행을 떨어뜨리면 "한 키워드가 여러 분야 카드에 동시에 올라왔다"는 증거가 사라진다).
  const topicsByKeyword: Record<string, string[]> = {};
  const addTopic = (keyword: string, topic: string | null | undefined): void => {
    const name = topic?.trim();
    if (!name) return;
    const key = normalizeKeyword(keyword);
    const list = topicsByKeyword[key] ?? (topicsByKeyword[key] = []);
    if (!list.includes(name)) list.push(name);
  };

  for (const source of enabledSources) {
    try {
      // latestAvailableTrendDate의 active 후보만 사용한다(오늘/어제로 날짜를 고정하지 않는다 -
      // 수집기가 이미 "데이터가 있는 날짜"를 trend_date로 저장해뒀으므로 그 값을 그대로 신뢰한다).
      const { candidates } = await resolveLoader(source, options)();
      for (const row of candidates) addTopic(row.keyword, row.topic);

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
    charGramEnabled:
      options.charGramFoldEnabled ??
      parseCharGramFoldEnabled(process.env[QUERY_POOL_FOLD_CHARGRAM_ENV]),
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
    topicsByKeyword,
    ...(firstError ? { trendError: firstError } : {}),
    trendErrorBySource,
  };
}
