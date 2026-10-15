// 엔터 트랙 "전 분야 트렌드" 게이트 설정 (KEYWORD-ENT-PURITY-2026-10.md A-3, 2026-10-16 사용자 승인).
//
// 무엇을 막는가: creator_advisor·google_trends·daum_realtime·community는 분야를 가리지 않는 그날의
// 화제를 준다. 그 후보가 엔터 풀에 **무필터로** 합류하는 것이 10/13 "카이스트 러너"(run #148 2위)와
// 10/15 "인천 흉기난동"(run #158 8위)의 공통 원인이다. 어휘 차단으로는 못 잡는다 - 사건·사고는
// 정치어도 스포츠어도 아니고, 연예인 추모 기사와 문자열만으로 구분되지 않는다.
//
// 실측된 경로(10/15): creator_advisor가 "인천 흉기난동 사건"을 **topic=방송**으로 올렸고
// (같은 날 같은 키워드가 topic=사회·정치로도 올라왔다), creatorAdvisorTopicMapping의
// "방송" -> entertainment를 타고 엔터 풀에 들어왔다. 즉 소스의 주제 라벨 자체를 믿을 수 없다.
//
// 설계 원칙 세 가지:
// 1) **시드가 아니라 후보를 본다.** 게이트는 collectCandidates 뒤에 선다. "유지원 러머" 같은
//    3음절 이름만 보고는 분야를 알 수 없지만, 그 이름으로 찾아온 기사 제목에는 신호가 있다.
// 2) **신인·무명을 죽이지 않는다.** 이름을 모른다는 이유로 떨어뜨리면 안 되므로, 판정 재료의
//    첫 번째는 역할어다("배우 OOO", "신인 그룹 OOO"). 이름이 생소해도 역할어가 있으면 통과한다.
// 3) **조용히 버리지 않는다.** 떨어뜨린 후보는 콘솔 + discovery_runs.metadata.trendGate에 남는다.
//    무엇을 잃었는지 사후에 셀 수 없는 필터는 운영에서 못 믿는다.
//
// 두 단계 판정을 **항상 함께 계산**해 어느 쪽을 쓸지 실측으로 고르게 한다:
// - strict: 엔터 신호가 없고 + **비엔터 카테고리가 확정**된 후보만 버린다(사건·사고/생활/커뮤니티).
//   "이지혜 성심당 논란"처럼 역할어도 작품어도 없지만 비엔터도 아닌 후보는 살아남는다.
// - loose: 엔터 신호가 없으면 버린다. 순도는 높지만 위 같은 정당 후보를 함께 죽인다.
// apply를 켜면 **strict만** 적용한다. loose는 preview 숫자로만 본다.

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

export const ENT_TREND_GATE_CONFIG = {
  /**
   * 판정을 계산해 로그·metadata에 남길지. 순수 함수라 비용이 사실상 없다(외부 호출 없음).
   * 끄려면 ENT_TREND_GATE_PREVIEW=false.
   */
  previewEnabled: parseBooleanEnv(process.env.ENT_TREND_GATE_PREVIEW, true),

  /**
   * 실제로 후보를 떨어뜨릴지(strict 기준). **기본 false를 유지한다.**
   * 1주 preview 실측(오탈락 건수)을 확인한 뒤에만 켠다 - mergeSameTopicClusters와 같은 절차다.
   * 켜려면 ENT_TREND_GATE_APPLY=true.
   */
  apply: parseBooleanEnv(process.env.ENT_TREND_GATE_APPLY, false),

  /**
   * 신호 ①: 인물 역할어. **이게 이 게이트의 핵심 안전장치다** - 이름을 모르는 신인·무명이
   * "배우"·"신인 그룹" 같은 역할어를 달고 나오면 그대로 통과한다.
   *
   * `감독`은 스포츠 감독과 겹치지만 스포츠는 이미 앞 단계(keywordExclusionRules)에서 빠진다.
   * `작가`는 웹툰·소설 작가까지 포함하는데, 원작 IP 기사는 ott 트랙이 다루는 주제라 의도한 통과다.
   */
  roleTerms: [
    "배우", "가수", "아이돌", "그룹", "멤버", "개그맨", "코미디언", "방송인", "연예인",
    "모델", "감독", "작가", "래퍼", "보컬", "댄서", "성우", "프로듀서", "아나운서",
    "유튜버", "인플루언서", "트로트", "주연", "조연", "출연자", "진행자", "소속사",
  ] as readonly string[],

  /**
   * 신호 ③: 매체·작품·제작 신호. classifyKeywordCategory(신호 ②)의 ott 어휘와 겹치는 것이
   * 있지만, 저쪽은 "첫 매칭 규칙이 이긴다"라서 앞 규칙(incident 등)에 선점되면 발화하지 않는다.
   * 여기서는 독립 신호로 한 번 더 본다.
   */
  mediaTerms: [
    "드라마", "영화", "예능", "시트콤", "뮤지컬", "콘서트", "앨범", "음원", "뮤직비디오",
    "컴백", "데뷔", "방영", "개봉", "출연", "캐스팅", "시사회", "팬미팅", "무대인사",
    "ost", "신곡", "화보", "열애", "결별", "은퇴", "하차", "스틸컷", "예고편",
    "넷플릭스", "티빙", "웨이브", "디즈니", "쿠팡플레이", "왓챠",
    "kbs", "mbc", "sbs", "jtbc", "tvn", "ena", "채널a", "mbn",
  ] as readonly string[],

  /**
   * strict 판정에서 "비엔터 확정"으로 볼 classifyKeywordCategory 결과.
   * parenting은 이미 수집 단계에서 전량 배제되지만, 규칙이 바뀌어도 안전하도록 남겨 둔다.
   */
  nonEntCategories: ["incident", "living", "community", "parenting"] as readonly string[],
} as const;
