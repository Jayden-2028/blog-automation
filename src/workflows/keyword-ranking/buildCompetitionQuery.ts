// canonical keyword -> 경쟁도 측정용 "핵심어 질의"를 만든다.
//
// 왜 필요한가(2026-09-04 실측):
// canonical keyword는 최대 8어절이라(CANONICAL_KEYWORD_CONFIG.targetMaxWords) 그대로 검색하면
// 사실상 문장 전체를 조회하게 된다. 그러면 측정되는 값이 "이 주제가 포화됐는가"가 아니라
// "이 어투를 쓴 블로그가 몇 개인가"가 된다. run #32~34 Top 10 실측에서 같은 행사가 이렇게 갈렸다:
//
//   3,081건  "2026 여의도 불꽃축제 일정·시간·명당·교통통제"
//       8건  "2026 여의도 불꽃축제 시간 헷갈리면 손해! 일정·명당·귀가"
//
// 같은 이슈인데 385배다. 표현이 다를 뿐인데 경쟁도가 뒤집히면 이 지표는 쓸 수 없다.
// (같은 사건인 "부산 오피스텔 추락사" 두 건도 206 vs 20으로 10배 차이였다.)
//
// 해결: 범용 수식어(일정/방법/결말/이유...)를 걷어내고 남는 핵심 명사 앞 2개만으로 조회한다.
// 위 두 항목 모두 "여의도 불꽃축제"가 되어 같은 값을 얻는다.
//
// 분류어(넷플릭스/티빙/육아...)는 **걷어내지 않는다.** topicGrouping은 "서로 다른 작품이 플랫폼
// 이름으로 묶이는 것"을 막으려고 분류어를 빼지만, 경쟁도 측정에서는 반대다 - "들쥐"만으로 조회하면
// 동음이의 문서까지 세어 실제 경쟁도가 부풀려진다. "넷플릭스 들쥐"가 우리가 쓸 제목에 더 가깝다.
//
// 알려진 한계: "앞에서부터 2개"는 서술형 헤드라인에서 주제가 아니라 주어절을 집는다.
//   "가해자 누나는 드라마 출연 중 부산 오피스텔 추락사" -> "가해자 누나는" (주제는 "오피스텔 추락사")
// 형태소 분석기 없이 헤드라인에서 주제를 정확히 뽑는 것은 이 파일 범위를 넘는다. 다만 같은 표현은
// 항상 같은 질의가 되므로(위 불꽃축제 사례) 지표의 일관성 자체는 깨지지 않는다. 실측에서 이 한계가
// 유의미한 왜곡을 만드는지 확인한 뒤, 필요하면 batch df 기반 distinctive token(topicGrouping.ts)을
// 쓰는 방향으로 올린다 - 그건 단일 키워드가 아니라 batch 전체를 봐야 하므로 호출부가 달라진다.

import {
  CANONICAL_KEYWORD_CONFIG,
  CLUSTERING_CONFIG,
  TOPIC_GROUPING_CONFIG,
} from "../../config/keywordScoring.js";
import { extractCoreNouns, normalizeTitle } from "./clustering/textNormalize.js";

const GENERIC_TOKENS = new Set(TOPIC_GROUPING_CONFIG.genericTokens.map((token) => token.toLowerCase()));
const STOPWORDS = new Set(CLUSTERING_CONFIG.stopwords.map((token) => token.toLowerCase()));

// clustering의 tokenize()를 쓰지 않는 이유(2026-09-04): 그쪽 stripJosaSuffix는 1글자 조사까지 떼어내
// "여의도" -> "여의"가 된다. 유사도 비교에서는 양쪽이 똑같이 망가지므로 무해하지만, 실제 검색
// 질의로 쓰면 전혀 다른 문서를 세게 된다. canonicalKeyword가 같은 이유로 1글자 조사를 뺀 별도
// 목록(wordTrailingJosaSuffixes)을 쓰고 있어 그것을 재사용한다 - 사람이 읽는 텍스트를 만든다는
// 목적이 같기 때문이다.
function stripTrailingJosa(token: string): string {
  for (const suffix of CANONICAL_KEYWORD_CONFIG.wordTrailingJosaSuffixes) {
    if (token.endsWith(suffix) && token.length - suffix.length >= CLUSTERING_CONFIG.minTokenLength) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function tokenizeForQuery(text: string): string[] {
  return normalizeTitle(text)
    .split(" ")
    .filter(Boolean)
    .map(stripTrailingJosa)
    .filter((token) => token.length >= CLUSTERING_CONFIG.minTokenLength && !STOPWORDS.has(token));
}

export type BuildCompetitionQueryOptions = {
  /** 질의에 넣을 핵심 명사 개수. 기본 2. */
  maxTerms?: number;
};

/**
 * 경쟁도 조회에 쓸 짧은 질의를 만든다. 핵심 명사를 못 찾으면 원문을 그대로 돌려준다
 * (측정을 포기하는 것보다 거친 값이라도 남기는 편이 낫다).
 */
export function buildCompetitionQuery(
  keyword: string,
  options: BuildCompetitionQueryOptions = {}
): string {
  const maxTerms = options.maxTerms ?? 2;

  const coreNouns = extractCoreNouns(tokenizeForQuery(keyword));
  const meaningful = coreNouns.filter((token) => !GENERIC_TOKENS.has(token.toLowerCase()));
  if (meaningful.length === 0) return keyword.trim();

  // 연도/회차 같은 숫자 시작 토큰("2026", "4차")은 주제를 가리키지 않으므로 뒤로 미룬다.
  // 다만 그것만 남는 경우까지 버리지는 않는다 - 그때는 없는 것보다 낫다.
  const nonNumeric = meaningful.filter((token) => !/^\d/.test(token));
  const ordered = nonNumeric.length >= Math.min(maxTerms, meaningful.length) ? nonNumeric : meaningful;

  return ordered.slice(0, maxTerms).join(" ");
}
