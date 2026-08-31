// 뉴스 매체명으로 키워드 category를 보강하는 규칙.
//
// 왜 필요한가(2026-08-29 실측): 구글 트렌드 KR TOP 10을 처음 실제로 받아보니 **10건 중 9건이
// 어휘 규칙(keywordCategoryRules)에 걸리지 않았다.** 급상승 검색어의 상당수가 인명·고유명사이기
// 때문이다. 구글 트렌드는 Creator Advisor와 달리 topic(분야)을 주지 않으므로 폴백할 곳도 없어
// 전부 living으로 떨어졌다 - 유재석/오연수/엄태웅이 "생활정보"가 됐다.
//
// category는 표시용이 아니라 원고 톤(buildArticlePrompt.pickStyleRules)과 Top 10 category
// backfill을 결정하므로, 이 오분류는 실제로 엉뚱한 톤의 원고를 만든다.
//
// 해결의 실마리: 구글 트렌드는 topic 대신 **그 검색어가 왜 떴는지 설명하는 뉴스 항목(출처 + 제목)**을
// 함께 준다. 그리고 한국 언론 지형에서 **스포츠지·연예매체에 실렸다는 사실 자체가 연예 뉴스라는
// 강한 신호**다. 인명 사전 없이 얻을 수 있는 정보 중 가장 신뢰도가 높다.
//
// 실측 검증(위 10건):
//   오연수  -> 스포츠조선  -> entertainment  ✅
//   유재석  -> 스포츠동아  -> entertainment  ✅
//   엄태웅  -> 스포츠동아  -> entertainment  ✅
//   나머지 7건(태풍/게임스컴/용종/자폭/션/창신메모리/포스코노조) -> 매칭 없음, 건드리지 않음
//   즉 오탐 0건. 신호가 없으면 조용히 물러난다.
//
// 뉴스 "제목" 어휘로도 분류해봤지만 효과가 없었다(태풍 1건만 잡았고 그건 이미 키워드에서 잡힌다).
// 오탐 위험만 늘리므로 채택하지 않았다 - 신호는 출처 하나만 쓴다.

/**
 * 연예/스포츠 전문 매체. 여기에 실렸으면 연예 뉴스로 본다.
 *
 * 스포츠지는 스포츠 경기 기사도 쓰지만, 이 블로그 맥락에서 선수 관련 글이 entertainment로 가는 것은
 * 문제가 되지 않는다(개인 블로그 톤이 적합하다는 점에서 연예와 같은 부류다).
 *
 * 종합지(조선일보/중앙일보/연합뉴스 등)는 넣지 않는다 - 연예부터 정치까지 다 쓰므로 신호가 되지 못한다.
 * 실제로 "션"이 조선일보 연예 기사로 떴지만, 조선일보를 넣으면 정치·경제 기사까지 연예가 된다.
 */
export const ENTERTAINMENT_NEWS_OUTLETS: readonly string[] = [
  "스포츠조선",
  "스포츠동아",
  "스포츠경향",
  "스포츠서울",
  "일간스포츠",
  "OSEN",
  "마이데일리",
  "텐아시아",
  "스타뉴스",
  "뉴스엔",
  "엑스포츠뉴스",
  "헤럴드팝",
  "디스패치",
  "스포티비뉴스",
  "SPOTV뉴스",
  "MK스포츠",
  "스포츠월드",
] as const;

/**
 * 뉴스 출처 목록에서 category 신호를 읽는다. 확실한 신호가 없으면 null을 반환해 호출자가
 * 기존 폴백을 그대로 쓰게 한다 - keywordCategoryRules와 같은 "보수적으로 동작한다" 원칙이다.
 *
 * 호출 순서가 중요하다: **키워드 어휘 판정이 먼저이고, 그것이 null일 때만 이 함수를 본다.**
 * 그래야 "아기 수족구" 같은 키워드가 스포츠지에 실려도 parenting을 유지한다.
 */
export function classifyCategoryByNewsOutlets(outlets: readonly (string | undefined)[]): string | null {
  for (const outlet of outlets) {
    if (!outlet) continue;
    const normalized = outlet.trim();
    if (!normalized) continue;

    if (ENTERTAINMENT_NEWS_OUTLETS.some((known) => normalized.includes(known))) {
      return "entertainment";
    }
  }

  return null;
}
