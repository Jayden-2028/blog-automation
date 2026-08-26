// clustering 전처리 유틸리티.
// HTML/특수문자 제거, 언론사/보도유형 boilerplate 제거, 숫자·날짜 normalization, 조사 제거, seed 검색어 제거를 담당한다.
// 형태소 분석기를 쓰지 않는 규칙 기반 근사치이므로 완벽하지 않다 (한계점은 README 대신 최종 요약에서 안내).

import { CLUSTERING_CONFIG } from "../../../config/keywordScoring.js";

const bracketRegexes = CLUSTERING_CONFIG.bracketPatterns.map((pattern) => new RegExp(pattern, "g"));
const boilerplateRegexes = CLUSTERING_CONFIG.genericBoilerplatePatterns.map(
  (pattern) => new RegExp(pattern, "gi")
);

// clustering 유사도 계산 전용 전처리: 주제 판단에 불필요한 site/source boilerplate(예: "위키백과 한국어",
// "나무위키")를 제거한다. "폭염 - 위키백과 한국어"와 "넷플릭스 - 위키백과 한국어"처럼 전혀 다른 주제의
// title이 공통 boilerplate 때문에 token/char n-gram 유사도가 높아져 false merge되는 것을 막기 위함.
// 원문 headline 자체는 건드리지 않고, CompositeSimilarityClusterer.prepare()가 clustering용 텍스트를
// 만들 때만 이 함수를 거친다(그 외 호출부는 이 전처리를 타지 않는다).
export function stripClusteringBoilerplate(text: string): string {
  return boilerplateRegexes.reduce((acc, regex) => acc.replace(regex, " "), text);
}

function stripBrackets(text: string): string {
  return bracketRegexes.reduce((acc, regex) => acc.replace(regex, " "), text);
}

// 쉼표 천단위 구분자 제거 + 흔한 한국어 날짜 표기를 하이픈 구분 형태로 통일.
// 예: "2026년8월24일" -> "2026-8-24", "8월24일" -> "8-24", "08.24" -> "08-24"
function normalizeNumbers(text: string): string {
  return text
    .replace(/(\d),(\d{3}\b)/g, "$1$2")
    .replace(/(\d{4})년\s?(\d{1,2})월\s?(\d{1,2})일?/g, "$1-$2-$3")
    .replace(/(\d{1,2})월\s?(\d{1,2})일/g, "$1-$2")
    .replace(/(\d{1,2})\.(\d{1,2})(?!\d)/g, "$1-$2");
}

// 한글/영문/숫자/공백/하이픈만 남기고 나머지 특수문자(HTML 잔여 태그 포함)는 공백으로 치환.
function stripPunctuation(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ");
}

export function normalizeTitle(text: string): string {
  const withoutBrackets = stripBrackets(text);
  const withNormalizedNumbers = normalizeNumbers(withoutBrackets);
  const withoutPunctuation = stripPunctuation(withNormalizedNumbers);
  return withoutPunctuation.toLowerCase().replace(/\s+/g, " ").trim();
}

function splitTokens(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

// 조사로 추정되는 접미사를 제거한다. 실제 조사가 아닌데 우연히 일치하는 경우도 있을 수 있는 근사치.
function stripJosaSuffix(token: string): string {
  for (const suffix of CLUSTERING_CONFIG.josaSuffixes) {
    if (
      token.endsWith(suffix) &&
      token.length - suffix.length >= CLUSTERING_CONFIG.minTokenLength
    ) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

export type TokenizeOptions = {
  /** 이 후보가 파생된 seed 검색어. 제공되면 해당 토큰을 결과에서 제외한다. */
  seedQuery?: string;
};

// token overlap / 핵심 명사 overlap 계산에 사용할 토큰 목록을 만든다.
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const seedTokens = new Set(
    options.seedQuery ? splitTokens(normalizeTitle(options.seedQuery)) : []
  );

  return splitTokens(normalizeTitle(text))
    .map(stripJosaSuffix)
    .filter(
      (token) =>
        token.length >= CLUSTERING_CONFIG.minTokenLength &&
        !CLUSTERING_CONFIG.stopwords.includes(token) &&
        !(CLUSTERING_CONFIG.excludeSeedQueryFromTokens && seedTokens.has(token))
    );
}

const VERB_ENDING_PATTERN = /(했다|였다|한다|됐다|이다|보인다|밝혔다|전했다|이라고|한다는|다는)$/;

// "핵심 명사"의 근사치: 순수 숫자/날짜 토큰과, 조사 제거 후에도 동사/서술형 어미로 끝나는 토큰을 제외한다.
// 형태소 분석 없이는 정확한 명사 추출이 불가능하므로 규칙 기반 근사치임을 명확히 한다.
export function extractCoreNouns(tokens: string[]): string[] {
  return tokens.filter(
    (token) => !/^[0-9-]+$/.test(token) && !VERB_ENDING_PATTERN.test(token)
  );
}

// character n-gram 비교용 전체 정규화 문자열. 조사/seed 제거를 하지 않아 원문 형태를 그대로 유지한다
// (seed 검색어도 자연스럽게 낮은 가중치로 남도록 하기 위함).
export function normalizedFullText(text: string): string {
  return normalizeTitle(text);
}
