// style-learn 공통 텍스트 유틸. 순수 함수만 둔다(네트워크·DB 없음).

/** 공백 제외 글자 수. */
export function countChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** 비교용 정규화: 마크다운 강조·인용부호·공백 차이를 지운다. */
export function normalizeForCompare(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/[“”"'‘’「」『』]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function ngrams(text: string, n: number): Set<string> {
  const s = normalizeForCompare(text);
  const out = new Set<string>();
  if (s.length < n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i += 1) out.add(s.slice(i, i + n));
  return out;
}

/** 문자 n-gram 집합의 Jaccard. */
export function ngramJaccard(a: string, b: string, n = 3): number {
  const sa = ngrams(a, n);
  const sb = ngrams(b, n);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** 작은 쪽 n-gram 중 큰 쪽에 있는 비율(윤문으로 길이가 달라져도 덜 떨어진다). */
export function ngramContainment(a: string, b: string, n = 3): number {
  const sa = ngrams(a, n);
  const sb = ngrams(b, n);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  return inter / Math.min(sa.size, sb.size);
}

/** 문자 bigram Dice. 문장 유사도·제목 유사도에 쓴다. */
export function diceSimilarity(a: string, b: string): number {
  const sa = ngrams(a, 2);
  const sb = ngrams(b, 2);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  return (2 * inter) / (sa.size + sb.size);
}

/** 문단 하나를 문장으로 쪼갠다. 종결부호 뒤 공백에서만 자른다("23.46g"·`다."라고`는 안 잘린다). */
export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…]["'”’)\]]?)\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 종결부호·따옴표·공백을 벗긴 어미 판정용 꼬리. */
function endingCore(sentence: string): string {
  return sentence.replace(/[\s.!?…"'”’)\]]+$/u, "");
}

export type SentenceStyle = "formal" | "polite" | "other";

/** 합니다체(~니다) / 해요체(~요·죠) / 그 외(명사형·인용 종결 등). */
export function sentenceStyle(sentence: string): SentenceStyle {
  const core = endingCore(sentence);
  if (/니다$/.test(core)) return "formal";
  if (/[요죠]$/.test(core)) return "polite";
  return "other";
}

/** 어미 빈도를 볼 패턴. 사용자가 애용하는 것(는데요·네요)과 규격상 금지/허용 경계에 있는 것들. */
export const ENDING_PATTERNS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
  { key: "는데요", pattern: /는데요/g },
  { key: "네요", pattern: /네요/g },
  { key: "죠", pattern: /[가-힣]죠[.!?]?(?![가-힣])/g },
  { key: "거든요", pattern: /거든요/g },
  { key: "더라고요", pattern: /더라고요/g },
  { key: "잖아요", pattern: /잖아요/g },
  { key: "답니다", pattern: /답니다/g },
  { key: "고요", pattern: /고요(?![가-힣])/g },
  { key: "군요", pattern: /군요/g },
  { key: "ㄹ 것 같", pattern: /[을를ㄹ] ?것 같/g },
];

export function countEndings(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key, pattern } of ENDING_PATTERNS) {
    const n = text.match(pattern)?.length ?? 0;
    if (n > 0) out[key] = n;
  }
  return out;
}

/** KST 기준 YYYY-MM-DD. */
export function kstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** ISO 주차("2026-W44"). 날짜 문자열(YYYY-MM-DD) 기준. */
export function isoWeekLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
