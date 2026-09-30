// 경쟁도 단계에서 LLM이 뽑아 둔 "주제어"로 두 후보가 같은 주제인지 판정한다(순수 함수).
//
// 왜 필요한가(2026-10-01, run #100 로그 실측):
// 다양성 선정의 주제 동일성 판정은 topicGrouping.isSameTopic()이고, 그 근거는 "batch 안에서 희소한
// 핵심 명사를 공유하는가"다. 그런데 희소 판정 임계가 `min(404 × 0.02, 12) ≈ 8`이라, 404개 cluster 중
// 8개 이하에 나오는 단어면 전부 "그날의 고유명사"로 인정된다. `들쥐`(4/404)가 희소인 것과 똑같이
// `여행`·`시청률`·`임신`·`vs`도 희소가 된다. 실제로 주제병합 preview에서 이렇게 묶였다:
//   [들쥐 결말 vs 원작] + [이세돌 vs 이세계아이돌] + [설현 vs 수지]   <- 공유 토큰: vs
//   [유부녀킬러 시청률 10.7%] + [재벌형사2 시청률] 7건               <- 공유 토큰: 시청률
// 문서빈도만으로는 **드문 고유명사**와 **드문 일반명사**를 구분할 수 없다. 이 모듈이 분류어
// (넷플릭스 등)에 대해 이미 겪고 고정 목록으로 막았던 문제가 일반 어휘에서 재발한 것이다.
//
// 반대 방향 오류도 같은 run에 있었다. LLM 주제어가 **글자 하나까지 똑같은** 두 후보가 각각 53점을
// 받고 따로 남았다:
//   [추무빈 열애 공개] 블로그 115건 | 49점 → 53점  ← 아빠 추신수 닮은 사랑꾼이었네 …
//   [추무빈 열애 공개] 블로그 115건 | 49점 → 53점  ← 추신수 아들이 벌써 21살 사랑꾼 …
//
// 즉 경쟁도 단계가 **이미 정답을 계산해 두고도** 그 정보가 선정에 전달되지 않고 있었다. 주제어는
// 제목에서 수식어를 걷어낸 2~5어절짜리 주제구라(extractTopicQueries.ts), 뉴스 제목 원문보다 훨씬
// 나은 판정 근거다. 추가 비용은 0이다 - 경쟁도가 다양성 선정 **직전**에 이미 뽑아 둔 값이다.
//
// 판정 규칙: 분류어·범용 수식어를 걷어낸 뒤 남은 핵심 토큰 집합이 **같거나 한쪽이 다른 쪽의
// 부분집합**이면 같은 주제로 본다.
//   [영화 옵세션 결말]      -> {옵세션}            \ 같음
//   [영화 옵세션 정보]      -> {옵세션}            /
//   [추무빈 열애 공개]      -> {추무빈, 열애}      \ 부분집합
//   [추무빈 여자친구 열애]  -> {추무빈, 여자친구, 열애} /
//   [브래드 피트 여자친구 열애] -> {브래드, 피트, 여자친구, 열애}  <- 위와 교집합은 {열애}뿐이고
//                                                                   부분집합이 아니라 다른 주제
// 교집합 크기가 아니라 부분집합을 쓰는 이유: 교집합 1개만 요구하면 `열애` 하나로 서로 다른 커플이
// 묶이고, 2개를 요구하면 [옵세션 결말]과 [옵세션 정보]를 못 잡는다. "한 주제어가 다른 주제어의 더
// 구체적인 형태인가"가 우리가 실제로 묻고 싶은 질문이다.

import { extractCoreNouns, tokenize } from "./clustering/textNormalize.js";

/**
 * 주제어에서 판정에 쓸 핵심 토큰만 남긴다. 걷어낼 게 너무 많아 아무것도 안 남으면 null -
 * 호출자가 "판정 불가"로 보고 기존 규칙에 맡긴다(빈 집합끼리 부분집합이 되어 전부 같은 주제로
 * 묶이는 사고를 막는다).
 */
export function buildTopicQueryCore(
  query: string | null | undefined,
  excludedTokens: ReadonlySet<string>
): Set<string> | null {
  if (!query) return null;

  const core = new Set<string>();
  for (const noun of extractCoreNouns(tokenize(query))) {
    const normalized = noun.toLowerCase();
    if (excludedTokens.has(normalized)) continue;
    core.add(normalized);
  }

  return core.size > 0 ? core : null;
}

function isSubsetOf(smaller: ReadonlySet<string>, larger: ReadonlySet<string>): boolean {
  for (const token of smaller) {
    if (!larger.has(token)) return false;
  }
  return true;
}

/**
 * 두 주제어가 같은 주제인지. 어느 한쪽이라도 판정할 수 없으면(주제어 없음, 핵심 토큰 0개) null을
 * 반환한다 - "다르다"가 아니라 "모르겠다"이므로 호출자가 기존 판정으로 넘겨야 한다.
 */
export function isSameTopicQuery(
  a: string | null | undefined,
  b: string | null | undefined,
  excludedTokens: ReadonlySet<string>
): boolean | null {
  const coreA = buildTopicQueryCore(a, excludedTokens);
  const coreB = buildTopicQueryCore(b, excludedTokens);
  if (!coreA || !coreB) return null;

  return coreA.size <= coreB.size ? isSubsetOf(coreA, coreB) : isSubsetOf(coreB, coreA);
}
