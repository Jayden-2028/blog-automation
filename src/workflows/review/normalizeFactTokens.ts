// 본문과 근거에서 "사실 토큰"(날짜·금액·수치)을 뽑아 같은 표기로 정규화한다.
//
// 왜 필요한가(SPRINT_3_DESIGN.md 4-1절): 검수의 팩트 검사는 "본문의 숫자가 근거에 있는가"를
// 보는데, 모델은 근거의 표기를 그대로 쓰지 않는다. 문자열 그대로 비교하면 멀쩡한 원고가 전부
// 걸린다:
//
//   근거: "2026. 9. 2.(수) ~ 10. 24.(토)"   본문: "9월 2일부터 10월 24일까지"
//   근거: "60,000원"                        본문: "6만 원"
//
// 그래서 양쪽을 정규화한 뒤 비교한다. 정규화로도 못 맞추는 표기는 남을 수밖에 없으므로, 이
// 모듈을 쓰는 검사는 결과를 "틀렸다"가 아니라 "근거에서 확인되지 않았다"로 표기해야 한다.

export type FactTokenKind = "date" | "money" | "number";

export type FactToken = {
  /** 원문에 나타난 그대로. 사람에게 무엇이 걸렸는지 보여줄 때 쓴다. */
  raw: string;
  /** 비교용 정규 형태. 같은 사실이면 표기가 달라도 이 값이 같아야 한다. */
  normalized: string;
  kind: FactTokenKind;
};

/** 한국어 수 단위. 큰 단위부터 곱해야 "1억 2천만"류가 어긋나지 않는다. */
const KOREAN_UNITS: ReadonlyArray<{ suffix: string; multiplier: number }> = [
  { suffix: "억", multiplier: 100_000_000 },
  { suffix: "만", multiplier: 10_000 },
  { suffix: "천", multiplier: 1_000 },
];

// 수치 뒤에 붙으면 "주장"으로 볼 만한 단위들. 단위 없는 맨숫자는 오탐이 너무 많아 제외한다
// (연도, 목록 번호, 조사에 섞인 숫자 등).
// 서수("3번째")는 뺀다 - 글의 구성을 가리키는 표현이지 근거에서 확인할 사실이 아니다
// (설계 4-1절의 "흔한 서수는 제외" 항목).
const MEANINGFUL_NUMBER_UNITS = [
  "명", "개", "분", "시간", "일간", "주", "개월", "년간", "회", "차", "석", "세", "층",
  "위", "점", "배", "퍼센트", "%", "kg", "km", "cm", "g", "ml", "L",
] as const;

/** 두 자리 미만 수치는 검사하지 않는다 - "1인", "2개" 같은 일반 표현이 대부분이라 오탐만 늘린다. */
const MIN_SIGNIFICANT_NUMBER = 10;

function pad2(value: string | number): string {
  return String(value).padStart(2, "0");
}

/**
 * 날짜를 뽑는다. 연도가 있으면 `YYYY-MM-DD`와 `MM-DD`를 함께 만든다 - 근거에 "2026. 9. 2."가
 * 있고 본문에 "9월 2일"만 있어도 같은 날짜로 인식돼야 하기 때문이다.
 */
function extractDates(text: string): FactToken[] {
  const tokens: FactToken[] = [];

  // "2026. 9. 2." / "2026년 9월 2일" / "2026-09-02" / "2026/9/2"
  const withYear = /(\d{4})\s*[.년\-/]\s*(\d{1,2})\s*[.월\-/]\s*(\d{1,2})\s*[.일]?/g;
  for (const match of text.matchAll(withYear)) {
    const [raw, year, month, day] = match;
    tokens.push({ raw: raw.trim(), normalized: `${year}-${pad2(month)}-${pad2(day)}`, kind: "date" });
    // 연도 없는 표기와도 맞물리도록 월-일 형태를 함께 남긴다.
    tokens.push({ raw: raw.trim(), normalized: `${pad2(month)}-${pad2(day)}`, kind: "date" });
  }

  // "9월 2일" (연도 없음)
  const monthDay = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
  for (const match of text.matchAll(monthDay)) {
    const [raw, month, day] = match;
    tokens.push({ raw: raw.trim(), normalized: `${pad2(month)}-${pad2(day)}`, kind: "date" });
  }

  // "10. 24." - 연도가 생략된 마침표 표기. 공공 페이지가 기간을 쓸 때 뒤쪽 날짜의 연도를 자주
  // 생략한다("2026. 9. 2.(수) ~ 10. 24.(토)"). 이걸 안 잡으면 근거에 분명히 있는 종료일이
  // 미검출로 걸린다(실제로 경복궁 근거에서 발생했다).
  // 끝 마침표를 필수로 두고 월/일 범위를 검증해 번호 매김("10. 24개 항목")과 구분한다.
  const bareDotted = /(?<!\d)(\d{1,2})\s*\.\s*(\d{1,2})\s*\./g;
  for (const match of text.matchAll(bareDotted)) {
    const [raw, month, day] = match;
    const m = Number(month);
    const d = Number(day);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      tokens.push({ raw: raw.trim(), normalized: `${pad2(month)}-${pad2(day)}`, kind: "date" });
    }
  }

  // "8/14", "10/24" - 슬래시 축약. 연도 4자리로 시작하는 경우는 위에서 이미 잡았다.
  const slashed = /(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/g;
  for (const match of text.matchAll(slashed)) {
    const [raw, month, day] = match;
    const m = Number(month);
    const d = Number(day);
    // 날짜로 해석 가능한 범위만 - "3/5 확률" 같은 분수를 날짜로 오인하지 않기 위한 최소 방어다.
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      tokens.push({ raw: raw.trim(), normalized: `${pad2(month)}-${pad2(day)}`, kind: "date" });
    }
  }

  return tokens;
}

/** "6만 원" -> 60000 처럼 한국어 수 단위를 숫자로 푼다. 단위가 없으면 그대로 숫자로 읽는다. */
function parseKoreanAmount(digits: string, unit: string | undefined): number | null {
  const base = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  if (!unit) return base;

  const found = KOREAN_UNITS.find((u) => u.suffix === unit);
  return found ? base * found.multiplier : base;
}

/** 금액을 뽑는다. "60,000원", "6만 원", "300만원대" 모두 같은 숫자로 정규화한다. */
function extractMoney(text: string): FactToken[] {
  const tokens: FactToken[] = [];

  // 숫자 + (선택) 한국어 단위 + "원". "대"/"가량" 같은 근사 접미사는 뒤에 붙어도 무시한다.
  // 숫자로 시작하도록 강제한다: `[\d,]+`로 쓰면 쉼표만 있어도 매칭돼 ", 원" 같은 조각이
  // money:0으로 잡힌다(2026-08-28 실측에서 실제로 발생).
  const pattern = /(\d[\d,]*(?:\.\d+)?)\s*([억만천])?\s*원/g;
  for (const match of text.matchAll(pattern)) {
    const [raw, digits, unit] = match;
    const amount = parseKoreanAmount(digits, unit);
    if (amount === null) continue;
    tokens.push({ raw: raw.trim(), normalized: `money:${amount}`, kind: "money" });
  }

  return tokens;
}

/** 의미 있는 단위가 붙은 수치를 뽑는다. 단위 없는 맨숫자는 오탐이 많아 제외한다. */
function extractNumbers(text: string): FactToken[] {
  const tokens: FactToken[] = [];
  const units = MEANINGFUL_NUMBER_UNITS.join("|");
  const pattern = new RegExp(String.raw`(\d[\d,]*(?:\.\d+)?)\s*([억만천])?\s*(${units})`, "g");

  for (const match of text.matchAll(pattern)) {
    const [raw, digits, koreanUnit, unit] = match;
    const value = parseKoreanAmount(digits, koreanUnit);
    if (value === null || value < MIN_SIGNIFICANT_NUMBER) continue;
    tokens.push({ raw: raw.trim(), normalized: `num:${value}:${unit}`, kind: "number" });
  }

  return tokens;
}

/**
 * 사실 토큰을 뽑기 전에 걷어내야 하는 것들을 제거한다.
 *
 * URL을 지우는 이유(2026-08-28 실측에서 발견): 퍼센트 인코딩된 한글 URL에서 가짜 수치가 쏟아진다.
 * `https://blog.naver.com/...%ED%98%BC...`에는 "98%"라는 문자열이 들어 있어 백분율로 잡혔고,
 * 재혼 황후 원고의 미검출 토큰 12개 중 10개가 전부 이런 URL 조각이었다. URL은 애초에 사실
 * 주장이 아니므로 검사 대상에서 빼는 게 맞다.
 */
function stripNonClaimText(text: string): string {
  return text
    // 마크다운 링크의 URL 부분만 제거하고 표시 텍스트는 남긴다(표시 텍스트에는 진짜 사실이 있을 수 있다).
    .replace(/\]\((https?:\/\/[^\s)]+)\)/g, "]()")
    // 맨 URL
    .replace(/https?:\/\/\S+/g, " ");
}

/** 텍스트에서 날짜·금액·수치를 모두 뽑는다. 같은 normalized 값은 한 번만 남긴다. */
export function extractFactTokens(rawText: string): FactToken[] {
  if (!rawText) return [];
  const text = stripNonClaimText(rawText);

  const all = [...extractDates(text), ...extractMoney(text), ...extractNumbers(text)];

  const seen = new Set<string>();
  return all.filter((token) => {
    if (seen.has(token.normalized)) return false;
    seen.add(token.normalized);
    return true;
  });
}

/** 근거 텍스트들에서 정규화된 사실 값의 집합을 만든다. 본문 토큰의 존재 여부를 이걸로 판정한다. */
export function buildFactCorpus(sourceTexts: ReadonlyArray<string | null | undefined>): Set<string> {
  const corpus = new Set<string>();
  for (const text of sourceTexts) {
    if (!text) continue;
    for (const token of extractFactTokens(text)) corpus.add(token.normalized);
  }
  return corpus;
}
