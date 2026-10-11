// "오늘의 핫이슈 스타 Top 5" 선별의 순수 로직(KEYWORD-REFRESH-2026-10.md §B).
// 네트워크·DB가 없어 tsx 테스트로 전부 검증한다. 호출·저장·발송은 runHotStarCollection.ts가 한다.
//
// 흐름: 당일 수집 재료(엔터 run의 keyword_rankings + 당일 trend_candidates) -> 재료 목록 조립 ->
//      LLM 1콜로 인물 5명 + 화제 배경 추출 -> 파싱·검증 -> 18시 알림 중복 표기 -> 텔레그램 본문.
//
// **기존 6-factor scoring·relevance·clustering 로직은 건드리지 않는다**(prod/CLAUDE.md 금지 항목).
// 이 모듈은 이미 저장된 결과를 읽어 사람 이름만 추려 보여줄 뿐이고, 점수를 다시 계산하지 않는다.
//
// 왜 LLM인가: "이 키워드가 사람 이름인가"는 규칙으로 풀리지 않는다. 한국어 인명은 품사 표지가 없고
// (작품명·그룹명·역할명이 섞인다), 조사가 붙어 오기도 한다. extractTopicQueries.ts가 같은 이유로
// LLM을 쓰고 있고, 실패하면 알림을 보내지 않는 쪽을 택했다 - 틀린 인물 5명을 매일 받는 것보다 낫다.

import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";

/** 알림에 올릴 인물 수 상한(§B: Top 5). 못 채우면 채운 만큼만 보낸다. */
export const HOT_STAR_TOP_N = 5;

/** LLM에 넘길 재료 상한. 당일 trend_candidates가 수백 건이라 프롬프트가 무한히 커지지 않게 막는다. */
export const HOT_STAR_MATERIAL_LIMIT = 120;

/** 배경 요약이 이보다 길면 모델이 문단을 돌려준 것으로 보고 자른다(§B: 1~2문장). */
export const HOT_STAR_BACKGROUND_MAX_CHARS = 180;

/** 인물명으로 볼 수 있는 길이. 너무 짧으면 조사 조각이고, 너무 길면 문장이다. */
const NAME_MIN_CHARS = 2;
const NAME_MAX_CHARS = 20;

export type HotStarMaterial = {
  /** 재료 문구(키워드 또는 트렌드 후보). */
  text: string;
  /** 원문 헤드라인이 있으면 맥락이 풍부해 선별 품질이 높다. */
  headline?: string | null;
  /** 어디서 왔는지. 프롬프트에 적지 않고 재료 집계(알림 꼬리말)에만 쓴다. */
  origin: "ranking" | "trend";
  /** trend_candidates.source 또는 run 종류. */
  source: string;
};

export type HotStarPerson = {
  rank: number;
  name: string;
  /** 화제가 된 배경 1~2문장. */
  background: string;
  /** 18시 엔터 키워드 알림에도 올라간 인물인가(§B: 중복 제거하지 않고 표기만 한다). */
  alsoInEveningNotification: boolean;
};

/**
 * 재료 목록을 조립한다. 같은 문구가 여러 소스에 있으면 한 번만 넘기고, 랭킹(엔터 저녁 회차)을
 * 트렌드 후보보다 앞에 둔다 - 상한에 걸려 잘릴 때 먼저 버려지는 쪽이 신호가 약한 쪽이어야 한다.
 */
export function buildHotStarMaterials(
  materials: readonly HotStarMaterial[],
  limit = HOT_STAR_MATERIAL_LIMIT
): HotStarMaterial[] {
  const seen = new Set<string>();
  const ordered = [
    ...materials.filter((item) => item.origin === "ranking"),
    ...materials.filter((item) => item.origin !== "ranking"),
  ];

  const picked: HotStarMaterial[] = [];
  for (const item of ordered) {
    const text = item.text.trim();
    if (!text) continue;
    const key = normalizeForMatch(`${text} ${item.headline ?? ""}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push({ ...item, text });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 비교용 정규형. 공백·구두점을 버리고 소문자로. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^0-9a-z가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildHotStarPrompt(materials: readonly HotStarMaterial[], topN = HOT_STAR_TOP_N): string {
  const numbered = materials
    .map((item, index) => {
      const headline = item.headline?.trim();
      return headline && headline !== item.text ? `${index + 1}. ${item.text} — ${headline}` : `${index + 1}. ${item.text}`;
    })
    .join("\n");

  // 출력 형식을 강하게 고정한다 - 파서가 읽는 출력이지 사람이 읽는 게 아니다.
  return [
    "너는 오늘 한국 연예·방송·영화 이슈에서 '가장 화제가 된 인물'을 고르는 도구다.",
    "",
    "아래는 오늘 수집된 키워드·트렌드 목록이다(뉴스 제목이 붙은 줄도 있다).",
    "",
    numbered,
    "",
    `이 목록을 근거로 **오늘 가장 이슈가 된 실제 인물 ${topN}명**을 고르고, 각자 왜 화제가 됐는지 쓴다.`,
    "**목록 전체를 본다** - 앞쪽 몇 줄에만 의존하지 말고 뒤쪽 트렌드 항목에서도 인물을 찾는다.",
    "",
    "규칙:",
    `- 한 줄에 하나씩, \`번호|인물명|화제가 된 배경\` 형식으로만 출력한다. 최대 ${topN}줄.`,
    "- 배경은 1~2문장. 목록에 적힌 내용만 쓰고, 목록에 없는 사실을 보태지 않는다.",
    "- 인물명은 사람 이름만 쓴다. 작품명·프로그램명·그룹명·회사명은 인물이 아니다.",
    "  (그룹 활동이 화제라면 그 안의 특정 멤버를 고르고, 특정할 수 없으면 그 줄을 쓰지 않는다)",
    "- 조사를 붙이지 않는다. '아이유가' (X) -> '아이유' (O)",
    "- 같은 인물을 두 줄에 쓰지 않는다.",
    "- 목록에서 인물을 특정할 수 없으면 **억지로 채우지 않는다.** 확실한 인물만 쓰고 줄 수를 줄인다.",
    "- 사건·사고·수사·사망 관련 인물은 고르지 않는다(이 알림은 연예 화제성 알림이다).",
    "- 설명, 머리말, 마무리 문장, 빈 줄, 표를 붙이지 않는다.",
  ].join("\n");
}

/**
 * `번호|인물명|배경` 줄을 파싱한다. 형식을 어긴 줄·중복 인물·빈 배경은 조용히 버린다 -
 * 모델이 한 줄을 흘렸을 때 그 줄만 빠지고 나머지는 살아야 한다(§B: 못 채우면 채운 만큼만).
 */
export function parseHotStarOutput(output: string, topN = HOT_STAR_TOP_N): { name: string; background: string }[] {
  const picked: { name: string; background: string }[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // "1|이름|배경" / "1. | 이름 | 배경" 등 흔한 변형을 함께 받는다.
    const match = /^(\d+)\s*[.)]?\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(line);
    if (!match) continue;

    const name = stripQuotes(match[2]).replace(/\s+/g, " ").trim();
    const background = stripQuotes(match[3]).replace(/\s+/g, " ").trim();

    if (name.length < NAME_MIN_CHARS || name.length > NAME_MAX_CHARS) continue;
    // 이름 자리에 문장이 온 경우(모델이 형식을 흘린 경우)는 버린다.
    if (name.split(" ").length > 4 || /[.!?]$/.test(name)) continue;
    if (!background) continue;

    const key = normalizeForMatch(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    picked.push({ name, background: truncateBackground(background) });
    if (picked.length >= topN) break;
  }

  return picked;
}

/**
 * 앞뒤를 **짝으로 감싼** 인용부호만 벗긴다. 양쪽을 따로 깎으면 본문의 인용부호가 깨진다 -
 * 실측(2026-10-11): `'살림남'에서 …`가 `살림남'에서 …`가 됐다.
 */
function stripQuotes(text: string): string {
  let out = text.trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u2018", "\u2019"],
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (out.length > 1 && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

function truncateBackground(text: string): string {
  if (text.length <= HOT_STAR_BACKGROUND_MAX_CHARS) return text;
  return `${text.slice(0, HOT_STAR_BACKGROUND_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * 18시 엔터 키워드 알림에 올라간 인물인지 표시한다. **중복을 제거하지 않는다**(§B 사용자 결정) -
 * 겹치면 그 항목에 한 줄 표기만 붙인다.
 *
 * 판정은 "그 인물 이름이 18시 알림 항목의 키워드·헤드라인에 들어 있는가"다. 키워드는 canonical로
 * 축약돼 있어 이름이 빠져 있을 수 있으므로 헤드라인까지 함께 본다.
 */
export function markEveningOverlap(
  people: readonly { name: string; background: string }[],
  eveningTexts: readonly string[]
): HotStarPerson[] {
  const haystack = eveningTexts.map(normalizeForMatch).filter(Boolean);
  return people.map((person, index) => ({
    rank: index + 1,
    name: person.name,
    background: person.background,
    alsoInEveningNotification: haystack.some((text) => text.includes(normalizeForMatch(person.name))),
  }));
}

export type HotStarMessageOptions = {
  /** 알림 기준 시각(KST 날짜 표기). */
  now: Date;
  /** 꼬리말에 적을 재료 내역. */
  materialSummary?: string;
};

/**
 * 텔레그램 본문(HTML). **버튼을 붙이지 않는다** - 이 알림은 읽는 용도이고 원고 제작 연결은
 * 카테고리 템플릿·기획 설계 후 별도 발주다(사용자 2026-10-11 결정). 호출자도 replyMarkup을 주지 않는다.
 */
export function formatHotStarMessage(people: readonly HotStarPerson[], options: HotStarMessageOptions): string {
  const date = options.now.toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [];
  lines.push("🌟 <b>오늘의 핫이슈 스타</b>");
  // 5명을 못 채운 날은 몇 명인지 적는다(§B: 억지로 채우지 않는다).
  lines.push(
    people.length >= HOT_STAR_TOP_N
      ? `${date} · Top ${HOT_STAR_TOP_N}`
      : `${date} · 오늘은 ${people.length}명 (재료가 부족해 ${HOT_STAR_TOP_N}명을 채우지 못했습니다)`
  );
  lines.push("");

  for (const person of people) {
    lines.push(`<b>${person.rank}. ${escapeTelegramHtml(person.name)}</b>`);
    lines.push(escapeTelegramHtml(person.background));
    if (person.alsoInEveningNotification) lines.push("↳ 18시 알림에도 선정");
    lines.push("");
  }

  lines.push("ℹ️ 읽기용 알림입니다 - 원고 제작은 18시 키워드 알림의 ✍️ Go로 진행하세요.");
  if (options.materialSummary) lines.push(`재료: ${options.materialSummary}`);

  return lines.join("\n");
}
