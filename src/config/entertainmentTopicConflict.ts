// 엔터 트랙 "topic 라벨 충돌" 게이트 설정 (2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R2).
//
// 무엇을 막는가: Creator Advisor는 **같은 키워드를 여러 topic 카드에 동시에 올린다.** 그래서 분야가
// 전혀 다른 사안이 "스타·연예인" 카드 한 장을 타고 엔터 풀에 정당하게 들어온다.
//
// 2026-11-10 run 260 실측(trend_candidates 11/09분):
//   젠슨 황 불륜   -> 비즈니스·경제 + 방송
//   앨리스황       -> 사회·정치 + 방송 + 비즈니스·경제
//   엘리스황       -> 사회·정치 + 비즈니스·경제 + 스타·연예인
// 엔비디아 CEO 불륜 스캔들이 그날 엔터 Top 10의 3칸(3·5·8위)을 먹었다. 어휘 차단으로는 못 잡는다 -
// `젠슨 황`은 사람 이름뿐이고, 기사 제목에 연예 어휘가 하나도 없어도 떨어지지 않는다
// (`entertainmentTrendGate`의 strict 판정은 **비엔터 카테고리가 확정**된 것만 버리는데, 이 후보들은
// `classifyKeywordCategory`가 null을 돌려줘 strict에 걸리지 않았다 - 같은 run에서 loose 245건 중
// 77건이 젠슨 계열이었다).
//
// 그래서 **소스가 스스로 남긴 교차 증거**를 쓴다. 같은 키워드가 같은 날 엔터 카드와 비엔터 카드에
// 동시에 올라왔다면, 그 키워드의 분야는 엔터가 아니라 "엔터 카드에 잘못 섞인 것"으로 본다.
// 외부 호출이 0이고 이미 DB에 있는 값만 보는 순수 판정이다.
//
// 설계 원칙 세 가지(entertainmentTrendGate.ts와 같다):
// 1) **사람이 큐레이션한 시드는 건드리지 않는다.** 판정 대상은 동적 소스 유래 entry(origin=
//    creator_advisor|trend)뿐이다. seed/merged는 그대로 통과한다.
// 2) **원본 topic 카드 제목으로 판정한다.** topic_normalized는 `비즈니스·경제`와 `국내여행`을
//    둘 다 `living`으로 뭉개므로(creatorAdvisorTopicMapping.ts) 어느 카드였는지 알 수 없다.
//    community 소스처럼 어느 목록에도 없는 topic은 신호를 만들지 않는다 - 더쿠는 연예 커뮤니티라
//    "비엔터 증거"로 쓰면 안 된다.
// 3) **조용히 버리지 않는다.** 기본은 preview이고, 무엇이 빠질지 콘솔 + discovery_runs.metadata.
//    topicConflict에 남는다. 적용은 1주 실측 뒤 ENT_TOPIC_CONFLICT_DROP로 켠다.

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

export const ENT_TOPIC_CONFLICT_CONFIG = {
  /**
   * 판정을 계산해 로그·metadata에 남길지. 순수 함수라 비용이 사실상 없다(외부 호출 없음).
   * 끄려면 ENT_TOPIC_CONFLICT_PREVIEW=false.
   */
  previewEnabled: parseBooleanEnv(process.env.ENT_TOPIC_CONFLICT_PREVIEW, true),

  /**
   * 실제로 시드를 풀에서 뺄지. **기본 false를 유지한다.**
   * 1주 preview 실측(오탈락 건수)을 확인한 뒤에만 켠다 - entertainmentTrendGate와 같은 절차다.
   * 켜려면 ENT_TOPIC_CONFLICT_DROP=true.
   */
  apply: parseBooleanEnv(process.env.ENT_TOPIC_CONFLICT_DROP, false),

  /**
   * 엔터 분야를 가리키는 Creator Advisor topic 카드 제목. 이 카드에 올라온 것이 엔터 풀에 들어오는
   * 정상 경로다(creatorAdvisorTopicMapping의 entertainment/ott 매핑과 같은 집합).
   */
  entertainmentTopics: ["방송", "스타·연예인", "드라마", "영화"] as readonly string[],

  /**
   * 비엔터 분야를 **확정**으로 보는 topic 카드 제목.
   *
   * `일상·생각`은 **의도적으로 뺐다** - 연예인 신변 이야기가 자연스럽게 들어가는 grab-bag 카드라
   * 비엔터 증거로 쓰면 정당 후보를 죽인다. `육아·결혼`도 뺐다(결혼·임신 연예 기사가 그 카드에
   * 올라온다). 남긴 것은 "연예 사안이 거기 올라올 이유가 없는" 카드뿐이다.
   * `사회·정치`는 매핑표에 없는 카드라 topic_normalized가 원문 그대로 남는다(실측 확인).
   */
  nonEntertainmentTopics: [
    "사회·정치",
    "비즈니스·경제",
    "IT·컴퓨터",
    "국내여행",
    "세계여행",
    "요리·레시피",
  ] as readonly string[],
} as const;
