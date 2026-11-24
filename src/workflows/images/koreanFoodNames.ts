// koreaplain 음식 글의 이미지 자리마다 **한국관광공사 관광사진 API에 넣을 한글 음식명**을 정한다(2026-11-25).
//
// 관광사진 API는 한글 키워드 검색이다. 이 트랙은 job 키워드·영어본이 로마자·영어라 한글을 따로 구해야 한다. 출처 우선순위:
//   1. 이미지 기획(imagePlan)의 그 자리 검색어 - 기획은 검색어를 한국어로 쓴다(planImageSlots.ts). 음식 사진 자리는
//      `queries[0]`에 한글 음식명을 단독으로 쓰라고 지시해 둔다.
//   2. 한글 초안의 같은 번호 마커(설명 + IMAGE PROMPT) - 번역은 마커 개수·순서를 보존한다(parseTranslationOutput.ts).
//   3. 기획 검색어가 사전에 없는 음식이면 그 검색어를 그대로(띄어쓰기 없는 한 단어일 때만).
//   4. 위가 다 비면 원고 단위: 한글 초안 제목 → job 키워드(로마자)를 사전(config/koreaplainDishHangul.ts)으로 옮긴 것.
// 지역은 검색어에 넣지 않고(결과가 좁아진다) 촬영지·제목 가점으로만 쓴다.
//
// 순수 함수다 - 네트워크·DB 없음.

import { KOREAN_DISH_HANGUL, KOREAN_REGION_HANGUL } from "../../config/koreaplainDishHangul.js";
import type { HangulDishEntry } from "../../config/koreaplainDishHangul.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";

/** 자리당 관광사진 키워드 상한(사용자 지시: 자리당 최대 2 키워드). */
export const KTO_KEYWORDS_PER_SLOT = 2;

export type KtoSlotHint = {
  /** API에 넣을 한글 키워드(앞에서부터, 최대 2개). */
  dishes: string[];
  /** 촬영지·제목 가점에 쓸 한글 지역명. */
  regions: string[];
  /** 음식명을 어디서 얻었나(로그·테스트용). */
  source: "plan" | "korean-draft" | "plan-literal" | "job";
};

const HANGUL = /[가-힣]/;
/** 그 자체로는 사진 주제가 못 되는 넓은 말 - 다른 음식명이 없을 때만 쓴다. */
const GENERIC_DISHES = new Set(["한식", "길거리음식"]);

function compact(text: string): string {
  return (text ?? "").replace(/\s+/g, "");
}

function romanTokens(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

type Hit<T> = { item: T; position: number };

/** 한글 본문에서 사전 항목을 찾는다. 긴 이름이 먼저 자리를 차지한다(떡갈비 안의 "갈비"를 따로 세지 않는다). */
function scanHangul<T>(text: string, entries: readonly T[], nameOf: (item: T) => string, minLength: number): Hit<T>[] {
  const source = compact(text);
  if (!source || !HANGUL.test(source)) return [];
  const taken = new Array<boolean>(source.length).fill(false);
  const hits: Hit<T>[] = [];
  const ordered = [...entries].filter((e) => nameOf(e).length >= minLength).sort((a, b) => nameOf(b).length - nameOf(a).length);
  for (const entry of ordered) {
    const name = nameOf(entry);
    // 같은 이름은 한 번만 세되, **나온 자리는 전부** 차지한다 - 안 그러면 "닭갈비 … 닭갈비"의 둘째 "갈비"가 따로 잡힌다.
    let from = 0;
    let first = -1;
    while (from <= source.length - name.length) {
      const at = source.indexOf(name, from);
      if (at < 0) break;
      const span = taken.slice(at, at + name.length);
      if (span.every((t) => !t)) {
        for (let i = at; i < at + name.length; i += 1) taken[i] = true;
        if (first < 0) first = at;
        from = at + name.length;
        continue;
      }
      from = at + 1;
    }
    if (first >= 0) hits.push({ item: entry, position: first });
  }
  return hits.sort((a, b) => a.position - b.position);
}

/** 로마자 본문에서 사전 항목을 찾는다(토큰 단위 연속 일치, 긴 표기가 먼저). */
function scanRoman<T>(text: string, entries: readonly T[], spellingsOf: (item: T) => readonly string[]): Hit<T>[] {
  const tokens = romanTokens(text);
  if (tokens.length === 0) return [];
  const taken = new Array<boolean>(tokens.length).fill(false);
  const phrases = entries
    .flatMap((item) => spellingsOf(item).map((spelling) => ({ item, phrase: romanTokens(spelling) })))
    .filter((p) => p.phrase.length > 0)
    .sort((a, b) => b.phrase.length - a.phrase.length || b.phrase.join(" ").length - a.phrase.join(" ").length);
  const hits: Hit<T>[] = [];
  const seen = new Set<T>();
  for (const { item, phrase } of phrases) {
    if (seen.has(item)) continue;
    for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
      if (!phrase.every((token, offset) => tokens[start + offset] === token)) continue;
      if (taken.slice(start, start + phrase.length).some(Boolean)) continue;
      for (let i = start; i < start + phrase.length; i += 1) taken[i] = true;
      hits.push({ item, position: start });
      seen.add(item);
      break;
    }
  }
  return hits.sort((a, b) => a.position - b.position);
}

/** 한글 글에서 음식명(두 글자 이상)을 나온 순서대로. */
export function hangulDishesIn(text: string): HangulDishEntry[] {
  return preferSpecific(scanHangul(text, KOREAN_DISH_HANGUL, (e) => e.hangul, 2).map((h) => h.item));
}

/** 로마자·영어 글(job 키워드)에서 음식명을 나온 순서대로. 한 글자 이름(떡)도 여기서는 받는다. */
export function romanizedDishesIn(text: string): HangulDishEntry[] {
  return preferSpecific(scanRoman(text, KOREAN_DISH_HANGUL, (e) => e.romanized).map((h) => h.item));
}

export function hangulRegionsIn(text: string): string[] {
  return scanHangul(text, KOREAN_REGION_HANGUL, (e) => e.hangul, 2).map((h) => h.item.hangul);
}

export function romanizedRegionsIn(text: string): string[] {
  return scanRoman(text, KOREAN_REGION_HANGUL, (e) => e.romanized).map((h) => h.item.hangul);
}

/**
 * 넓은 말(한식·길거리음식)은 다른 음식명 뒤로 보낸다. 같은 글에 일반 이름(막국수)과 그 지역 고유 이름(춘천막국수)이 둘 다
 * 나오면 고유 이름을 일반 이름 자리로 올린다 - 일반 이름은 키워드 생성(ktoKeywordsFor)이 base로 다시 붙인다.
 */
function preferSpecific(entries: HangulDishEntry[]): HangulDishEntry[] {
  const specificFor = new Map<string, HangulDishEntry>();
  for (const entry of entries) if (entry.base && !specificFor.has(entry.base)) specificFor.set(entry.base, entry);
  const merged: HangulDishEntry[] = [];
  for (const entry of entries) {
    const replacement = specificFor.get(entry.hangul) ?? entry;
    if (!merged.includes(replacement)) merged.push(replacement);
  }
  return [...merged.filter((e) => !GENERIC_DISHES.has(e.hangul)), ...merged.filter((e) => GENERIC_DISHES.has(e.hangul))];
}

/** 음식 항목 → API 키워드(최대 2개): 첫 음식명, 그다음은 그 음식의 일반 이름(나주곰탕 → 곰탕) 또는 두 번째 음식명. */
export function ktoKeywordsFor(entries: readonly HangulDishEntry[], max: number = KTO_KEYWORDS_PER_SLOT): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    if (value && !out.includes(value) && out.length < max) out.push(value);
  };
  const [first, ...rest] = entries;
  if (!first) return out;
  push(first.hangul);
  push(first.base);
  for (const entry of rest) push(entry.hangul);
  return out;
}

/** 기획 검색어가 사전에 없는 음식일 때: 띄어쓰기 없는 한글 한 단어(2~10자)면 그대로 쓴다. 문장형 검색어는 받지 않는다. */
function literalDish(queries: readonly string[]): string | null {
  for (const query of queries) {
    const q = (query ?? "").trim();
    if (/^[가-힣]{2,10}$/.test(q)) return q;
  }
  return null;
}

export type BuildKtoSlotHintsInput = {
  /** job 키워드(영문 검색 질의, 예: "chuncheon dakgalbi"). */
  keyword: string;
  /** 한글 초안 제목. 없으면 생략. */
  koreanTitle?: string | null;
  slots: {
    index: number;
    /** 기획이 이 자리에 정한 검색어(한국어). */
    planQueries?: readonly string[];
    /** 한글 초안의 같은 번호 마커 설명 + IMAGE PROMPT. */
    koreanText?: string | null;
  }[];
};

/**
 * 자리별 관광사진 검색 힌트. 음식명을 하나도 못 구한 자리는 결과에 넣지 않는다(그 자리는 관광사진을 건너뛴다).
 */
export function buildKtoSlotHints(input: BuildKtoSlotHintsInput): Record<number, KtoSlotHint> {
  const jobEntries = [...hangulDishesIn(input.koreanTitle ?? ""), ...romanizedDishesIn(input.keyword)].filter(
    (entry, i, all) => all.findIndex((other) => other.hangul === entry.hangul) === i
  );
  const jobRegions = [...hangulRegionsIn(input.koreanTitle ?? ""), ...romanizedRegionsIn(input.keyword)];

  const hints: Record<number, KtoSlotHint> = {};
  for (const slot of input.slots) {
    const planText = (slot.planQueries ?? []).filter((q) => HANGUL.test(q ?? "")).join(" ");
    const koreanText = slot.koreanText ?? "";

    let source: KtoSlotHint["source"] = "plan";
    let entries = hangulDishesIn(planText);
    let dishes: string[] = ktoKeywordsFor(entries);
    if (dishes.length === 0) {
      source = "korean-draft";
      entries = hangulDishesIn(koreanText);
      dishes = ktoKeywordsFor(entries);
    }
    if (dishes.length === 0) {
      const literal = literalDish(slot.planQueries ?? []);
      if (literal) {
        source = "plan-literal";
        dishes = [literal];
      }
    }
    if (dishes.length === 0) {
      source = "job";
      entries = jobEntries;
      dishes = ktoKeywordsFor(entries);
    }
    if (dishes.length === 0) continue;

    const regions = [
      ...hangulRegionsIn(`${planText} ${koreanText}`),
      ...jobRegions,
      ...entries.map((e) => e.region).filter((r): r is string => !!r),
    ].filter((region, i, all) => all.indexOf(region) === i);
    hints[slot.index] = { dishes, regions, source };
  }
  return hints;
}

/**
 * 한글 초안에서 자리별 "마커 설명 + IMAGE PROMPT"를 뽑는다. 번호는 본문 마커 순서(1부터)라 영어본 자리 번호와 같다
 * (번역이 마커 개수·순서를 보존한다).
 */
export function koreanSlotTexts(koreanBody: string, imagePrompts: readonly string[]): Record<number, string> {
  const texts: Record<number, string> = {};
  let index = 0;
  for (const block of parseManuscriptBlocks(koreanBody ?? "", [...imagePrompts])) {
    if (block.type !== "image") continue;
    index += 1;
    texts[index] = [block.description, block.prompt ?? ""].filter(Boolean).join(" ");
  }
  return texts;
}

/**
 * prepareManuscript가 부르는 한 줄 진입점: 기획 검색어 + 한글 초안 + job 키워드로 자리별 힌트를 만든다.
 * `slotCount`는 본문 이미지 자리 수(영어본 기준).
 */
export function buildKoreaplainKtoHints(input: {
  keyword: string;
  koreanTitle?: string | null;
  koreanBody?: string | null;
  imagePrompts?: readonly string[];
  planQueries?: Record<number, readonly string[]>;
  slotCount: number;
}): Record<number, KtoSlotHint> {
  const texts = input.koreanBody ? koreanSlotTexts(input.koreanBody, input.imagePrompts ?? []) : {};
  const slots = Array.from({ length: Math.max(0, input.slotCount) }, (_, i) => i + 1).map((index) => ({
    index,
    planQueries: input.planQueries?.[index] ?? [],
    koreanText: texts[index] ?? "",
  }));
  return buildKtoSlotHints({ keyword: input.keyword, koreanTitle: input.koreanTitle ?? null, slots });
}
