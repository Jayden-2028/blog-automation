// 사용설명서 트랙 주제 후보를 고르는 순수 로직(개편3 §4.2). 네트워크·DB가 없어 tsx 테스트로 검증한다.
//
// 흐름: 시드(날짜로 돌림) -> 자동완성 제안 -> 제외 규칙 -> 후보 병합 -> 점수 -> 기발행/기제안 중복 제거 ->
//      **체류 실용 정보 하한** + 라벨 다양성 상한 선정.
//
// 📌 선정 기준(2026-10-11, KEYWORD-REFRESH-2026-10.md §C): **실제 한국에 체류하며 필요한 실용 정보를
// 입국 전 문화 소개와 동등하게 우선한다.** 라벨 상한(perLabelCap)만 있으면 "쏠리지 않게" 막을 뿐이라,
// 문화 소개 라벨이 셋(Food·Culture·K-Wave)이고 실용 라벨이 하나(Living in Korea)인 구성에서는 실용
// 주제가 매일 0~1건으로 밀렸다. 그래서 상한과 짝이 되는 **하한**을 둔다(practicalFloor).
// 이 트랙의 선정은 LLM 프롬프트가 아니라 이 파일의 결정 규칙이 전부다 - 기준은 여기 적는다.
// 점수는 한국 키워드 파이프라인의 6-factor가 아니다(그건 뉴스·트렌드 기반이라 에버그린에는 안 맞는다) -
// 같은 이름의 컬럼(keyword_rankings.*_score)에 채워 넣어 Go/Pass 알림·job 생성 경로를 그대로 쓸 뿐이다.

import { KSCENE_DEFAULT_LABEL, KSCENE_LABEL_BY_SEED, KSCENE_LABELS, type KsceneLabel, type KsceneSeed } from "../../config/ksceneSeeds.js";
import type { RankedKeyword } from "../../types/keywordScoring.js";

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is", "are", "do", "does", "can", "i", "my", "you", "your",
  "how", "what", "why", "when", "where", "which", "with", "from", "by", "it", "be", "there", "vs",
]);

/** 소문자, 구두점 제거, 공백 정리. 비교·중복 판정용 정규형. */
export function normalizeTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 의미 있는 토큰(불용어 제거, 단순 복수형 정규화). */
export function topicTokens(text: string): string[] {
  return normalizeTopic(text)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map((token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token));
}

/** 토큰 집합 자카드 유사도(0~1). */
export function topicSimilarity(a: string, b: string): number {
  const setA = new Set(topicTokens(a));
  const setB = new Set(topicTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** 후보가 이미 쓴/제안한 주제와 같은 주제인가. */
export function isDuplicateTopic(topic: string, existing: readonly string[], threshold: number): boolean {
  const normalized = normalizeTopic(topic);
  return existing.some((other) => normalizeTopic(other) === normalized || topicSimilarity(topic, other) >= threshold);
}

// ---------- 제외 규칙 ----------

/** 정치·안보·성인·도박·약물 등 이 블로그가 다루지 않는 주제(애드센스 정책 + 정체성). */
const EXCLUDED_TERMS = [
  "north korea", "nuclear", "war", "military", "president", "election", "politic", "protest", "yoon", "lee jae",
  "porn", "sex", "escort", "nude", "adult", "casino", "gambling", "betting", "bet365", "drug", "weed", "cannabis", "marijuana",
  "scandal", "suicide", "death", "dies", "murder", "crime", "arrest", "lawsuit",
];

/** 글이 될 수 없는 내비게이션·로컬·시의성 질의. */
const LOW_VALUE_TERMS = [
  "near me", "reddit", "youtube", "tiktok", "instagram", "login", "log in", "pdf", "download", "torrent", "free online",
  "today", "tonight", "live", "news", "stock", "price chart", "meaning in english", "lyrics", "mp3", "wallpaper", "twitter",
];

function containsTerm(normalized: string, term: string): boolean {
  // 단어 경계로 본다("war"가 "warm"을 잡지 않게). 구(phrase)는 그대로 포함 검사.
  return new RegExp(`(^| )${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(normalized) ||
    (term.length > 5 && normalized.includes(term));
}

/**
 * **체류 실용 정보** 신호(2026-10-11, §C). 라벨이 "Living in Korea"면 그것만으로 실용으로 보고,
 * 다른 라벨(특히 Travel & Transit)에서도 환승·개통·납부·행정 절차처럼 "살면서 해야 하는 일"이면 센다.
 *
 * 문화 소개(축제·예절·역사)는 여기 들어오지 않는다 - 그쪽은 이미 충분히 뽑히고 있어 하한이 필요 없다.
 */
const PRACTICAL_TERMS = [
  "transfer", "transit card", "t money", "tmoney", "recharge", "top up", "commute", "rush hour",
  "traffic", "jaywalking", "crosswalk", "driver license", "driving",
  "sim", "usim", "esim", "phone plan", "phone number", "activation", "verification", "mobile banking",
  "bank account", "atm", "remittance", "wire transfer", "tax", "pension", "payroll",
  "registration", "arc", "alien registration", "visa extension", "immigration office", "report",
  "insurance", "hospital", "clinic", "pharmacy", "prescription", "appointment", "emergency",
  "recycling", "garbage", "trash", "food waste", "utility", "utilities", "bill", "bills", "payment",
  "rent", "jeonse", "deposit", "lease", "contract", "internet installation", "wifi",
  "delivery app", "karrot", "secondhand", "apartment", "gym membership", "post office", "parcel",
  "renewal", "refund", "documents", "paperwork",
  // "rules"·"how to"·"apply" 같은 범용 의도어는 넣지 않는다 - 문화 소개 주제("korean dining etiquette
  // rules")까지 실용으로 세어 하한이 의미를 잃는다. 생활 행정·교통·통신·의료·주거 **영역어**만 둔다.
] as const;

/** 이 후보가 체류 실용 정보인가. 라벨 또는 문구로 판정한다. */
export function isPracticalTopic(topic: string, label: KsceneLabel): boolean {
  if (label === "Living in Korea") return true;
  const normalized = normalizeTopic(topic);
  return PRACTICAL_TERMS.some((term) => containsTerm(normalized, term));
}

export function isExcludedTopic(topic: string): boolean {
  const normalized = normalizeTopic(topic);
  return [...EXCLUDED_TERMS, ...LOW_VALUE_TERMS].some((term) => containsTerm(normalized, term));
}

/** 단어 수·길이가 글 주제로 쓸 만한가(너무 짧으면 막연하고 너무 길면 질문 한 줄이다). */
export function hasUsableShape(topic: string): boolean {
  const words = normalizeTopic(topic).split(" ").filter(Boolean);
  return words.length >= 3 && words.length <= 10 && normalizeTopic(topic).length >= 12;
}

// ---------- 시드 선정 ----------

/**
 * 오늘 돌릴 시드를 고른다. 날짜(일 단위 정수)로 시작점을 돌려 전체 시드가 며칠 안에 한 바퀴 돈다.
 * 라벨이 섞이도록 라벨별로 번갈아 뽑는다.
 */
export function pickSeedsForDay(seeds: readonly KsceneSeed[], dayIndex: number, count: number): KsceneSeed[] {
  const byLabel = new Map<KsceneLabel, KsceneSeed[]>();
  for (const seed of seeds) byLabel.set(seed.label, [...(byLabel.get(seed.label) ?? []), seed]);
  const labels = KSCENE_LABELS.filter((label) => byLabel.has(label));
  if (labels.length === 0) return [];

  const picked: KsceneSeed[] = [];
  let round = 0;
  while (picked.length < Math.min(count, seeds.length)) {
    for (const label of labels) {
      const pool = byLabel.get(label)!;
      const seed = pool[(dayIndex * Math.ceil(count / labels.length) + round) % pool.length];
      if (!picked.includes(seed)) picked.push(seed);
      if (picked.length >= count) break;
    }
    round += 1;
    if (round > seeds.length) break; // 안전장치
  }
  return picked;
}

/** 자동완성 변형 질의: 시드 그대로 + 날짜로 돌리는 알파벳 한 글자(롱테일을 다양하게). */
export function autocompleteQueriesForSeed(seed: string, dayIndex: number): string[] {
  const letter = String.fromCharCode("a".charCodeAt(0) + (dayIndex % 26));
  return [seed, `${seed} ${letter}`];
}

// ---------- 후보·점수 ----------

export type SuggestionObservation = {
  /** 제안된 질의 원문. */
  suggestion: string;
  /** 제안을 낳은 시드 문구. */
  seed: string;
  /** 제안 목록에서의 위치(0이 맨 앞 = 수요가 가장 크다). */
  position: number;
};

export type TopicCandidate = {
  topic: string;
  seed: string;
  label: KsceneLabel;
  /** 이 주제가 관찰된 횟수(시드·변형 질의를 가로질러). */
  hits: number;
  /** 관찰된 가장 앞선 위치. */
  bestPosition: number;
};

/** 시드와 한 토큰도 안 겹치는 제안(자동완성이 엉뚱한 곳으로 샌 경우)은 버린다. */
function sharesSeedToken(suggestion: string, seed: string): boolean {
  const seedTokens = new Set(topicTokens(seed));
  return topicTokens(suggestion).some((token) => seedTokens.has(token));
}

export function buildCandidates(observations: readonly SuggestionObservation[], labelBySeed: Readonly<Record<string, KsceneLabel>> = KSCENE_LABEL_BY_SEED): TopicCandidate[] {
  const byKey = new Map<string, TopicCandidate>();

  for (const obs of observations) {
    const topic = normalizeTopic(obs.suggestion);
    if (!hasUsableShape(topic) || isExcludedTopic(topic) || !sharesSeedToken(topic, obs.seed)) continue;

    const existing = byKey.get(topic);
    if (existing) {
      existing.hits += 1;
      existing.bestPosition = Math.min(existing.bestPosition, obs.position);
    } else {
      byKey.set(topic, {
        topic,
        seed: obs.seed,
        label: labelBySeed[obs.seed] ?? KSCENE_DEFAULT_LABEL,
        hits: 1,
        bestPosition: obs.position,
      });
    }
  }
  return [...byKey.values()];
}

const QUESTION_STARTERS = ["how", "what", "why", "when", "where", "which", "can", "do", "does", "is", "are", "should"];
const GUIDE_WORDS = ["guide", "tips", "tip", "explained", "etiquette", "rules", "best", "vs", "difference", "first time", "beginner", "cost", "worth"];

export type TopicScore = { total: number; demand: number; crossSignal: number; specificity: number; intent: number };

/** 0~100. 수요(자동완성 위치) 40 + 반복 관찰 15 + 구체성 20 + 안내글 의도 15 + 기본 10. */
export function scoreTopic(candidate: TopicCandidate): TopicScore {
  const demand = Math.round(Math.max(0, 10 - candidate.bestPosition) / 10 * 40);
  const crossSignal = Math.round((Math.min(candidate.hits, 3) - 1) / 2 * 15);

  const wordCount = candidate.topic.split(" ").length;
  const specificity = wordCount >= 4 && wordCount <= 7 ? 20 : wordCount === 3 || wordCount === 8 ? 10 : 5;

  const normalized = candidate.topic;
  const isQuestion = QUESTION_STARTERS.some((starter) => normalized.startsWith(`${starter} `));
  const hasGuideWord = GUIDE_WORDS.some((word) => containsTerm(normalized, word));
  const intent = isQuestion ? 15 : hasGuideWord ? 10 : 0;

  return { total: Math.min(100, 10 + demand + crossSignal + specificity + intent), demand, crossSignal, specificity, intent };
}

/** 체류 실용 정보 하한의 기본값(2026-10-11, §C). topN=8이면 3건 - 라벨 상한(3)과 같은 크기다. */
export function defaultPracticalFloor(topN: number): number {
  return Math.min(topN, Math.max(2, Math.round(topN / 3)));
}

/**
 * 후보를 점수순으로 정렬하고 ① 후보끼리 비슷한 것 ② 기발행·기제안과 같은 것을 걷어낸 뒤 topN을 뽑는다.
 *
 * 두 규칙이 함께 작동한다:
 *   · **하한(practicalFloor)** - 체류 실용 정보를 먼저 그 수만큼 채운다(§C, 2026-10-11). 실용 후보가
 *     그보다 적으면 있는 만큼만 - 억지로 만들지 않는다.
 *   · **상한(perLabelCap)** - 한 라벨로 쏠리지 않게 막는다. 하한으로 먼저 뽑은 것도 이 상한에 포함해
 *     세므로, 실용 하한이 상한을 넘어 한 라벨을 독점하지 않는다.
 * 둘을 적용하고도 자리가 남으면 점수순으로 채운다(상한 무시 - 비우는 쪽이 손해다, 기존 동작).
 */
export function selectTopics(
  candidates: readonly TopicCandidate[],
  options: {
    topN: number;
    existingTopics: readonly string[];
    similarity: number;
    perLabelCap?: number;
    /** 체류 실용 정보 최소 건수. 생략하면 defaultPracticalFloor(topN). 0을 주면 하한을 끈다. */
    practicalFloor?: number;
  }
): { selected: (TopicCandidate & { score: TopicScore })[]; droppedAsDuplicate: number } {
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreTopic(candidate) }))
    .sort((a, b) => b.score.total - a.score.total || a.topic.localeCompare(b.topic));

  const kept: typeof scored = [];
  let droppedAsDuplicate = 0;
  for (const candidate of scored) {
    const dup = isDuplicateTopic(candidate.topic, options.existingTopics, options.similarity) ||
      kept.some((other) => topicSimilarity(candidate.topic, other.topic) >= options.similarity);
    if (dup) {
      droppedAsDuplicate += 1;
      continue;
    }
    kept.push(candidate);
  }

  const cap = options.perLabelCap ?? Math.max(2, Math.ceil(options.topN / 3));
  const floor = options.practicalFloor ?? defaultPracticalFloor(options.topN);
  const perLabel = new Map<KsceneLabel, number>();
  const selected: typeof kept = [];

  const take = (candidate: (typeof kept)[number]): void => {
    perLabel.set(candidate.label, (perLabel.get(candidate.label) ?? 0) + 1);
    selected.push(candidate);
  };

  // 1) 실용 하한을 점수순으로 먼저 채운다. 라벨 상한은 여기서도 지킨다.
  for (const candidate of kept) {
    if (selected.length >= Math.min(floor, options.topN)) break;
    if (!isPracticalTopic(candidate.topic, candidate.label)) continue;
    if ((perLabel.get(candidate.label) ?? 0) >= cap) continue;
    take(candidate);
  }

  // 2) 나머지는 기존대로 점수순 + 라벨 상한.
  for (const candidate of kept) {
    if (selected.length >= options.topN) break;
    if (selected.includes(candidate)) continue;
    if ((perLabel.get(candidate.label) ?? 0) >= cap) continue;
    take(candidate);
  }

  // 3) 상한 때문에 자리가 남으면 점수순으로 채운다.
  for (const candidate of kept) {
    if (selected.length >= options.topN) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }

  return { selected: selected.sort((a, b) => b.score.total - a.score.total), droppedAsDuplicate };
}

/** 선정 결과를 keyword_rankings에 저장하는 RankedKeyword로 바꾼다(Go/Pass 알림·job 생성 경로 재사용). */
export function toRankedKeywords(selected: readonly (TopicCandidate & { score: TopicScore })[]): RankedKeyword[] {
  return selected.map((item, index) => ({
    rank: index + 1,
    keyword: item.topic,
    headline: item.topic,
    // seedQuery = 이 주제를 낳은 시드 문구. 발행 시 Blogger 라벨을 KSCENE_LABEL_BY_SEED[seedQuery]로 정한다.
    seedQuery: item.seed,
    category: "kscene",
    totalScore: item.score.total,
    scoreBreakdown: {
      trendMomentum: 0,
      newsVelocity: 0,
      contentDemand: item.score.demand,
      freshness: 0,
      crossSourceSignal: item.score.crossSignal,
      clickPotential: item.score.intent + item.score.specificity,
      total: item.score.total,
    },
    trendDirection: "unknown",
    relatedCount: item.hits,
    sources: ["google_autocomplete"],
    latestPublishedAt: null,
    reason: `${item.label} · 자동완성 ${item.bestPosition + 1}번째 · ${item.hits}회 관찰`,
  }));
}
