// cluster(같은 이슈로 묶인 KeywordCandidate 묶음) 안에서 대표 seedQuery/category/headline을
// "같은 이슈 귀속(attribution)" 기준으로 일관되게 선택한다.
//
// 이전 구현의 문제: aggregateClusterSignals.ts가 category는 cluster에 가장 먼저 들어온 candidate에서,
// representative headline은 clusterer가 고른 "가장 짧은 title"에서 각각 독립적으로 가져오고,
// 대표 seedQuery는 trend momentum이 가장 큰 query를 또 별도로 골랐다. cluster에 여러 seedQuery가
// 섞이면(예: "쿠팡플레이"와 "폭염" 후보가 우연히 한 cluster로 묶인 경우) 이 셋이 서로 다른 candidate를
// 기준으로 정해져 headline은 A query 소식인데 seedQuery/category는 B로 표시되는 등 attribution이
// 어긋날 수 있었다.
//
// 해결: 대표 seedQuery를 먼저 하나 확정한 뒤, headline/category는 반드시 "그 seedQuery에 속한
// candidate들" 안에서만 고른다 — 세 값이 항상 같은 이슈(같은 seedQuery 그룹)를 가리키게 만든다.
//
// 대표 seedQuery 선택 순서: 1) candidate 수 최다 -> 2) 평균 relevanceScore 최고 -> 3) seed priority
// 최고 -> 4) cluster.items에 먼저 등장한 seedQuery(결정적 fallback, 무작위성 없음).
// 대표 headline 선택 순서(대표 seedQuery 그룹 내에서만): 0) **소스 등급**(날짜 있는 뉴스 > 날짜 있는
// 블로그 > 무날짜·웹, 2026-10-21 추가 - HEADLINE_SOURCE_PRIORITY=false면 생략) -> 1) relevanceScore 최고 -> 2) 최신 발행 ->
// 3) 제목 길이가 더 짧은 쪽(기존 clusterer의 pickRepresentative와 동일한 근사치, 최종 결정적 tie-break).

import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

// ---------- 헤드라인 소스 우선순위 (2026-10-21, KEYWORD-HEADLINE-FRESHNESS-2026-10.md ②) ----------
//
// 왜: run 182 [2]가 "11월 결혼 취소 케데헌 이재"였다. 같은 풀에 정상 기사("샘 킴과 부부 됐다")가
// 여러 건 있었는데도 **루머성 블로그 제목**이 keyword가 됐다. 기존 정렬이 relevanceScore를 1차 키로
// 쓰기 때문이다 - 제목과 시드의 토큰 중복이 높으면 블로그든 날짜 없는 웹문서든 이긴다.
//
// 그래서 소스 등급을 1차 키로 올린다: 날짜 있는 뉴스 > 날짜 있는 블로그 > 나머지(무날짜·웹).
// 뉴스가 한 건이라도 있으면 블로그 루머 제목이 표기가 될 수 없다. 등급 안에서는 기존 정렬
// (relevance -> 날짜 -> 길이)을 그대로 쓴다.
//
// 이 변경은 **이미 만들어진 cluster에서 어느 제목을 표기로 쓸지**만 바꾼다. 점수(scoreKeyword)·
// relevance 필터·cluster 구성은 건드리지 않는다(CLAUDE.md 금지 목록).
export const HEADLINE_SOURCE_PRIORITY_ENV = "HEADLINE_SOURCE_PRIORITY";

const PRIORITY_OFF_VALUES = new Set(["false", "0", "off", "no"]);

/** HEADLINE_SOURCE_PRIORITY 해석. 미설정·빈 값은 켜짐이고, false/0/off/no면 기존 정렬로 돌아간다. */
export function parseHeadlineSourcePriority(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return !PRIORITY_OFF_VALUES.has(normalized);
}

/**
 * 헤드라인 소스 등급(작을수록 우선). "publishedAt 보유 여부 + source"로만 판정한다.
 *   0 = 날짜 있는 뉴스 / 1 = 날짜 있는 블로그 / 2 = 그 외(웹문서, 날짜 파싱 실패 뉴스·블로그)
 */
export function headlineSourceGrade(item: KeywordCandidate): number {
  if (freshnessTimestamp(item) === Number.NEGATIVE_INFINITY) return 2;
  if (item.source === "naver_news") return 0;
  if (item.source === "naver_blog") return 1;
  return 2;
}

export type ResolveClusterAttributionOptions = {
  /** 소스 등급 정렬을 쓸지. 생략하면 env HEADLINE_SOURCE_PRIORITY(기본 켜짐)를 읽는다. */
  headlineSourcePriority?: boolean;
};

export type ClusterAttribution = {
  seedQuery: string | null;
  category: string;
  headline: string;
  /** 여러 seedQuery가 섞여 대표를 명시적으로 선택해야 했던 경우의 선택 사유. 없으면 null. */
  selectionNote: string | null;
  /** cluster 안에서 seedQuery별 candidate 개수(디버그/리포트용). */
  candidateCountBySeed: Record<string, number>;
  /** cluster 안에서 seedQuery별 평균 relevanceScore(디버그/리포트용). relevanceScore가 없는 candidate는 1(중립)로 취급. */
  averageRelevanceBySeed: Record<string, number>;
  /** cluster를 구성하는 candidate들의 고유 source 목록(디버그/리포트용). */
  sources: string[];
};

function readRelevance(item: KeywordCandidate): number {
  const value = item.metadata.relevanceScore;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function readSeedQuery(item: KeywordCandidate): string | undefined {
  const value = item.metadata.query;
  return typeof value === "string" && value ? value : undefined;
}

function freshnessTimestamp(item: KeywordCandidate): number {
  if (!item.publishedAt) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(item.publishedAt).getTime();
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

// clustering 유사도 계산과는 무관한, 최종 표시용 tie-break("제목이 더 짧은 쪽").
// 기존 CompositeSimilarityClusterer.pickRepresentative와 동일한 근사치를, seedQuery 정보가
// 전혀 없는 cluster(fallback 경로)에서도 재사용한다.
function shortestTitle(items: KeywordCandidate[]): string {
  if (items.length === 0) return "";
  return items.reduce(
    (shortest, item) => (item.keyword.length < shortest.length ? item.keyword : shortest),
    items[0].keyword
  );
}

type SeedGroup = {
  seedQuery: string;
  items: KeywordCandidate[];
  count: number;
  averageRelevance: number;
  category: string;
};

export function resolveClusterAttribution(
  items: KeywordCandidate[],
  priorityByQuery: Record<string, number> = {},
  options: ResolveClusterAttributionOptions = {}
): ClusterAttribution {
  const useSourcePriority =
    options.headlineSourcePriority ??
    parseHeadlineSourcePriority(process.env[HEADLINE_SOURCE_PRIORITY_ENV]);
  const sources = Array.from(new Set(items.map((item) => item.source)));

  const groupsByQuery = new Map<string, SeedGroup>();
  const groupOrder: string[] = [];

  for (const item of items) {
    const seedQuery = readSeedQuery(item);
    if (!seedQuery) continue;

    let group = groupsByQuery.get(seedQuery);
    if (!group) {
      group = { seedQuery, items: [], count: 0, averageRelevance: 0, category: item.category };
      groupsByQuery.set(seedQuery, group);
      groupOrder.push(seedQuery);
    }
    group.items.push(item);
    group.count += 1;
  }

  for (const group of groupsByQuery.values()) {
    const total = group.items.reduce((sum, item) => sum + readRelevance(item), 0);
    group.averageRelevance = group.items.length > 0 ? total / group.items.length : 0;
  }

  const candidateCountBySeed: Record<string, number> = {};
  const averageRelevanceBySeed: Record<string, number> = {};
  for (const seedQuery of groupOrder) {
    const group = groupsByQuery.get(seedQuery)!;
    candidateCountBySeed[seedQuery] = group.count;
    averageRelevanceBySeed[seedQuery] = Number(group.averageRelevance.toFixed(3));
  }

  // candidate 중 seedQuery metadata가 있는 게 하나도 없으면(예: 외부에서 query 없이 넣은 candidate)
  // 예전과 동일하게 "정보 없음" fallback으로 처리한다.
  if (groupOrder.length === 0) {
    const headline = shortestTitle(items);
    return {
      seedQuery: null,
      category: items[0]?.category ?? "uncategorized",
      headline,
      selectionNote: null,
      candidateCountBySeed,
      averageRelevanceBySeed,
      sources,
    };
  }

  let winner = groupsByQuery.get(groupOrder[0])!;
  for (let i = 1; i < groupOrder.length; i++) {
    const group = groupsByQuery.get(groupOrder[i])!;

    if (group.count > winner.count) {
      winner = group;
      continue;
    }
    if (group.count < winner.count) continue;

    if (group.averageRelevance > winner.averageRelevance) {
      winner = group;
      continue;
    }
    if (group.averageRelevance < winner.averageRelevance) continue;

    const groupPriority = priorityByQuery[group.seedQuery] ?? 0;
    const winnerPriority = priorityByQuery[winner.seedQuery] ?? 0;
    if (groupPriority > winnerPriority) {
      winner = group;
    }
    // 그래도 동률이면 groupOrder(=cluster.items에 먼저 등장한 순서) 상 앞선 seed를 그대로 유지한다.
  }

  const isMultiSeed = groupOrder.length > 1;
  const selectionNote = isMultiSeed
    ? `cluster에 여러 seed query 혼재(${groupOrder.join(", ")}) → candidate ${winner.count}건 · ` +
      `평균 relevance ${winner.averageRelevance.toFixed(2)}로 "${winner.seedQuery}" 선택`
    : null;

  const headlineCandidates = [...winner.items].sort((a, b) => {
    if (useSourcePriority) {
      const gradeDiff = headlineSourceGrade(a) - headlineSourceGrade(b);
      if (gradeDiff !== 0) return gradeDiff;
    }
    const relevanceDiff = readRelevance(b) - readRelevance(a);
    if (relevanceDiff !== 0) return relevanceDiff;
    const freshnessDiff = freshnessTimestamp(b) - freshnessTimestamp(a);
    if (freshnessDiff !== 0) return freshnessDiff;
    return a.keyword.length - b.keyword.length;
  });

  return {
    seedQuery: winner.seedQuery,
    category: headlineCandidates[0].category,
    headline: headlineCandidates[0].keyword,
    selectionNote,
    candidateCountBySeed,
    averageRelevanceBySeed,
    sources,
  };
}
