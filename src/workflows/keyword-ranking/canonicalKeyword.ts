// cluster의 대표 headline(뉴스/블로그 title 원문)에서 짧은 대표 검색 키워드(canonical keyword)를 만든다.
// 형태소 분석기/LLM 없이 규칙 기반으로만 동작하는 1차 근사치다: 괄호/따옴표/언론사명/문장형 어미/말줄임표를
// 제거하고 목표 어절 수(2~8)로 축약한다. "9월 반기신청" -> "반기신청"처럼 완전한 의미 압축까지는 못하고,
// headline 앞부분 위주로 핵심 entity+주제를 남기는 수준의 근사치임을 명확히 해둔다.

import { CANONICAL_KEYWORD_CONFIG, CLUSTERING_CONFIG } from "../../config/keywordScoring.js";

const bracketRegexes = CLUSTERING_CONFIG.bracketPatterns.map((pattern) => new RegExp(pattern, "g"));
const sentenceEndingRegex = new RegExp(
  `(${CANONICAL_KEYWORD_CONFIG.sentenceEndingSuffixes.join("|")})$`
);
const droppableMidTokenRegexes = CANONICAL_KEYWORD_CONFIG.droppableMidTokenPatterns.map(
  (pattern) => new RegExp(pattern)
);
// 흔한 quote/인용부호류. 반각/전각 따옴표, 낫표(「」『」), 화살괄호형 따옴표(‘’“”) 모두 제거한다.
const QUOTE_CHARS_PATTERN = /['"`‘’“”「」『』]/g;
// 쉼표/콜론/세미콜론/파이프처럼 단어 사이를 구분만 하는 구두점. 그대로 두면 앞뒤 단어에 들러붙어
// (예: 따옴표를 지운 자리에 남은 ",시즌2") 지저분한 canonical keyword가 되므로 공백으로 치환한다.
const STRAY_PUNCTUATION_PATTERN = /[,;:|]/g;
// 말줄임표(..., …)는 뉴스 title에서 "잘림 표시"(맨 끝)로도, "쉼표 대신 쓰는 구두점"(문장 중간)으로도 쓰인다.
// 중간에 있을 때 그대로 두면 앞뒤 어절이 공백 없이 붙어버리므로(예: "돌입…하영" -> 한 토큰으로 오인),
// 위치와 무관하게 전부 공백으로 치환한다. 잘림 여부(끝에 있었는지)는 치환 전에 별도로 판단한다.
const ELLIPSIS_ANYWHERE_PATTERN = /\.{2,}|…/g;
const TRAILING_ELLIPSIS_PATTERN = /(\.{2,}|…)\s*$/;

function stripBrackets(text: string): string {
  return bracketRegexes.reduce((acc, regex) => acc.replace(regex, " "), text);
}

function stripQuotes(text: string): string {
  return text.replace(QUOTE_CHARS_PATTERN, " ");
}

function stripStrayPunctuation(text: string): string {
  return text.replace(STRAY_PUNCTUATION_PATTERN, " ");
}

// 언론사명을 단어 경계 기준으로 제거한다(제목 안 어디에 있든).
function stripKnownOutlets(text: string): string {
  return CANONICAL_KEYWORD_CONFIG.knownOutlets.reduce((acc, outlet) => {
    if (!acc.includes(outlet)) return acc;
    return acc.split(outlet).join(" ");
  }, text);
}

function hasTrailingEllipsis(text: string): boolean {
  return TRAILING_ELLIPSIS_PATTERN.test(text);
}

// 말줄임표를 위치와 무관하게 공백으로 치환한다(위 ELLIPSIS_ANYWHERE_PATTERN 설명 참고).
function stripEllipsis(text: string): string {
  return text.replace(ELLIPSIS_ANYWHERE_PATTERN, " ");
}

// 문장형 서술어로 끝나는 마지막 어절을 제거한다("...밝혔다", "...나왔다" 등).
function stripSentenceEndingClause(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return text;

  const lastWord = words[words.length - 1];
  if (sentenceEndingRegex.test(lastWord) && words.length > CANONICAL_KEYWORD_CONFIG.targetMinWords) {
    return words.slice(0, -1).join(" ");
  }
  return text;
}

// CLUSTERING_CONFIG.stopwords와 같은 성격의 보도유형/범용 수식어를 제거한다(맨 앞 토큰은 예외).
function stripGenericDroppableWords(words: string[]): string[] {
  return words.filter(
    (word, index) => index === 0 || !CANONICAL_KEYWORD_CONFIG.genericDroppableWords.includes(word)
  );
}

// 어절 끝에 붙은 조사를 제거해 단어 자체 길이를 줄인다(어절 개수는 그대로).
// 제거 후 남는 길이가 2자 미만이면(의미 손실 위험) 원래 단어를 그대로 둔다.
function stripWordTrailingJosa(word: string): string {
  for (const suffix of CANONICAL_KEYWORD_CONFIG.wordTrailingJosaSuffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 2) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

// 목표 어절 수를 넘기면, 맨 앞 토큰은 유지한 채 순수 날짜/월 표기처럼 의미 손실이 적은 중간 토큰부터 제거한다.
function dropLowValueMidTokens(words: string[]): string[] {
  if (words.length <= CANONICAL_KEYWORD_CONFIG.targetMaxWords) return words;

  const result = [...words];
  for (let i = 1; i < result.length && result.length > CANONICAL_KEYWORD_CONFIG.targetMaxWords; i++) {
    if (droppableMidTokenRegexes.some((regex) => regex.test(result[i]))) {
      result.splice(i, 1);
      i--;
    }
  }
  return result;
}

export function buildCanonicalKeyword(headline: string): string {
  const original = headline.trim();
  if (!original) return original;

  let text = stripBrackets(original);
  text = stripQuotes(text);
  text = stripStrayPunctuation(text);
  text = stripKnownOutlets(text);
  text = text.replace(/\s+/g, " ").trim();

  // 말줄임표로 "끝나는" headline은 마지막 어절이 잘려나간 상태일 가능성이 높으므로, 치환 전에 미리
  // 판단해두고 치환 후 마지막 어절을 함께 제거한다.
  const wasTruncated = hasTrailingEllipsis(text);
  text = stripEllipsis(text);
  text = text.replace(/\s+/g, " ").trim();

  if (wasTruncated) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > CANONICAL_KEYWORD_CONFIG.targetMinWords) {
      text = words.slice(0, -1).join(" ");
    }
  }

  text = stripSentenceEndingClause(text);
  text = text.replace(/\s+/g, " ").trim();

  let words = text.split(/\s+/).filter(Boolean);
  words = stripGenericDroppableWords(words);
  words = words.map(stripWordTrailingJosa).filter(Boolean);
  words = dropLowValueMidTokens(words);

  if (words.length > CANONICAL_KEYWORD_CONFIG.targetMaxWords) {
    words = words.slice(0, CANONICAL_KEYWORD_CONFIG.targetMaxWords);
  }

  const canonical = words.join(" ").trim();
  // 과도한 축약으로 빈 문자열이 되면 원문 headline으로 fallback한다(정보 손실 방지).
  return canonical || original;
}
