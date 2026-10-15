// 블로그 경쟁도(포화도) 측정 설정.
//
// 왜 필요한가(2026-09-03): 현재 6-factor scoring은 100점 중 55점이 "이미 많이 다뤄지고 있는가"를
// 측정한다(newsVelocity 20 + contentDemand 15 + freshness 15 + crossSource 10). 특히 contentDemand는
// 블로그/웹문서가 많을수록 가점인데, 개인 블로그가 상위노출을 노리는 입장에서는 정확히 반대 신호다 -
// 블로그 문서가 많다는 건 이미 포화됐다는 뜻이다. 실제로 사용자가 "이미 뜬 키워드는 늦다"고 느낀
// 원인이 여기다.
//
// 왜 KeywordScoreInput.blogCount로는 안 되는가: 그 값은 cluster 안의 naver_blog "항목 수"이고
// displayPerQuery(5~10)로 상한이 걸려 있어 시장 포화도와 무관하다. 검색 응답의 total 필드도
// seed query 기준("넷플릭스" 전체 문서 수)이라 개별 이슈("넷플릭스 들쥐")의 포화도가 아니다.
// 그래서 최종 후보의 canonical keyword로 블로그 검색을 한 번 더 호출해 total을 받는다(프로브).
//
// 2단계 도입:
// - Phase A(현재): 프로브로 측정만 하고 점수에는 반영하지 않는다(applyToScore=false).
//   임계값(몇 건부터 레드오션인가)을 근거 없이 정할 수 없으므로, 실제 분포를 먼저 관측한다.
// - Phase B: 관측된 분포로 임계값을 확정하고 contentDemand를 재정의한다.
//   **6-factor scoring 변경이므로 사용자 승인이 필요하다**(CLAUDE.md "승인 없이는 금지").

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseFloatEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const BLOG_COMPETITION_CONFIG = {
  /**
   * 프로브(측정) 자체의 on/off. false면 daily workflow가 competition 단계를 건너뛴다.
   * 끄려면 BLOG_COMPETITION_PROBE_ENABLED=false.
   *
   * 기본 true인 근거: 읽기 전용 관측이고, Top 10에 대해서만 도므로 API 호출 10회 · 약 2초다.
   * 점수/순위/알림 내용에는 아무 영향이 없다(applyToScore가 게이트).
   */
  enabled: parseBooleanEnv(process.env.BLOG_COMPETITION_PROBE_ENABLED, true),

  /**
   * 측정한 경쟁도를 실제 점수에 반영할지(Phase B 게이트). **기본 false를 유지한다.**
   * true로 바꾸는 것은 6-factor scoring 변경이므로 사용자 승인 없이 하지 않는다.
   */
  applyToScore: parseBooleanEnv(process.env.BLOG_COMPETITION_APPLY_TO_SCORE, false),

  /**
   * 프로브를 돌릴 최대 키워드 수(원래 점수 기준 상위 N건).
   *
   * 30 → 60으로 올린다(2026-09-18, applyToScore를 켜면서). **프로브 창을 고르는 기준이 바로
   * 포화도를 모르는 옛 점수**라, 기회도 점수가 끌어올릴 키워드를 체계적으로 창 밖에 남긴다.
   * 실측(오늘 preview): 희소 키워드는 감점이 아니라 **가점**을 받는다.
   *   [노영국 사망 3주기] 80건(희소)    30점 → 35점
   *   [손예진 현빈 모자이크] 279건(희소) 42점 → 45점
   *   [넷플릭스 인형] 84,966건(포화)    31점 → 22점
   * 가점 폭이 +5라, 30위 근처에 몰려 있는(실측 대부분 30~31점) 희소 키워드가 창 밖이면 영영
   * 올라오지 못한다. 창을 넓히는 비용은 네이버 블로그 검색 30회 추가(약 5초)뿐이다.
   */
  probeMaxKeywords: parseIntEnv(process.env.BLOG_COMPETITION_PROBE_MAX, 60),

  /** 프로브 호출 사이 지연(ms). rate limit 보호. 기존 provider들과 같은 값. */
  requestDelayMs: parseIntEnv(process.env.BLOG_COMPETITION_DELAY_MS, 150),

  /**
   * 포화도 정규화 구간(블로그 문서 총 수). log10 스케일로 보간한다.
   * total <= low  -> saturation 0 (공급 희소 = 선점 기회)
   * total >= high -> saturation 1 (포화)
   *
   * 2026-09-04 확정. run #34~35 Top 18의 LLM 주제어 조회 분포로 정했다
   * (최소 30 / 25% 301 / 중앙값 1,277 / 75% 18,266 / 최대 142,812).
   *
   * 100 / 100,000을 고른 이유:
   * - 잠정치(300/50,000)는 하단 4건이 전부 0.00으로 뭉개졌다. "301건"과 "30건"은 10배 차이인데
   *   구분이 안 됐다.
   * - 더 넓히면(50/150,000) 뭉개짐은 사라지지만 상단에서 142,812와 98,477을 0.99 vs 0.95로
   *   구분하려 든다. 10만 건이 넘으면 어차피 승산이 없으므로 거기서 clamp되는 편이 옳다.
   * - 자릿수 기준(10^2 / 10^5)이라 18건짜리 표본에 과적합되지 않는다.
   *
   * 표본이 아직 작으므로 데이터가 쌓이면 재검토한다. env로 조정 가능하다.
   */
  lowTotalThreshold: parseIntEnv(process.env.BLOG_COMPETITION_LOW_TOTAL, 100),
  highTotalThreshold: parseIntEnv(process.env.BLOG_COMPETITION_HIGH_TOTAL, 100000),

  /**
   * (A) 기회도 가점을 받기 위한 **수요 하한**. contentCountPercentile이 이 값 미만이면 기회도를
   * 0으로 본다(가점 없음). 2026-10-16 도입, 사용자 승인.
   *
   * 왜(run #158 실측): 경쟁도 60건 중 **51건이 가점**(평균 블로그 1,518건)이고 감점은 8건
   * (평균 16,955건)이었다. 거의 전원 가점이면 변별력이 아니라 편향이다. 원인은 기존
   * contentDemand가 "cluster 안의 blog/web 항목 수"라 얕은 cluster에 0점을 주던 자리를,
   * 기회도가 누구에게나 몇 점씩 주는 값으로 바꿔 놓았기 때문이다 - 15점이 통째로 평탄해졌다.
   *
   * 0.3을 고른 근거: 기회도의 수요 신호는 batch 내 백분위라, 하위 30%는 "그날 배치 안에서도
   * 논의되지 않는" 자리다. run #158 3위 "스틸시리즈 센세이"(게이밍 기어 신제품)의 수요 백분위가
   * 0.21로 바로 이 구간이었다. 임계값은 실측이 쌓이면 재검토한다 - env로 조정 가능하다.
   */
  minDemandPercentile: parseFloatEnv(process.env.BLOG_COMPETITION_MIN_DEMAND, 0.3),

  /**
   * (B) **희소 하한**. 블로그 문서가 이 수보다 적으면 "선점 기회"가 아니라 "수요 부재 의심"으로
   * 보고 포화도를 thinSaturation으로 올려 가점을 절반으로 깎는다. 2026-10-16 도입, 사용자 승인.
   *
   * 왜: "블로그 글이 없다"에는 두 가지 뜻이 있는데 지금은 하나로 취급한다 -
   *   ① 오늘 터진 이슈라 아직 아무도 안 썼다(노리는 것)
   *   ② 애초에 아무도 관심이 없다(지금 같이 올라오는 것)
   * 구분 신호는 뉴스 속도와 검색 트렌드인데 기회도 계산은 둘 다 안 본다. 그래서 ②를 완전히
   * 걸러내는 대신 **가점 폭만 절반으로** 줄인다 - 진짜 속보 선점까지 죽이지 않기 위함이다.
   *
   * 100을 고른 근거: lowTotalThreshold와 같은 자리다. 지금은 100건 이하가 곧바로 포화도 0(가점
   * 최대)인데, 그 구간이 바로 run #158에서 ▲11~▲15칸씩 올라온 자리였다(블로그 60·131·139·149건).
   */
  thinTotalThreshold: parseIntEnv(process.env.BLOG_COMPETITION_THIN_TOTAL, 100),
  /** 희소 하한에 걸린 후보에게 적용할 포화도 하한. 0.5 = 가점이 절반으로 깎인다. */
  thinSaturation: 0.5,

  /**
   * 프로브 실패(API 오류 등)로 total을 모르는 경우 적용할 중립 비율(0~1).
   * 0으로 두면 "측정 실패"가 "완전 포화"와 같아져 부당하게 불리해지므로 중간값을 둔다
   * (FRESHNESS_CONFIG.neutralScoreRatio와 같은 철학).
   */
  neutralScoreRatio: 0.5,
} as const;

// 같은 주제 cluster 2차 병합(mergeSameTopicClusters.ts) 설정.
//
// 왜 별도 게이트인가: clustering 결과를 바꾸는 것은 CLAUDE.md "승인 없이는 금지" 항목이다.
// 그래서 기본값은 **preview만**이다 - 무엇이 합쳐질지 로그로만 남기고 실제 cluster는 그대로 둔다.
// 실측 로그를 사용자가 확인하고 승인한 뒤에만 applyToClusters를 켠다.
export const TOPIC_MERGE_CONFIG = {
  /**
   * 병합 대상을 계산해 로그로 남길지. 계산 자체는 순수 함수이고 외부 호출이 없어 비용이 사실상
   * 없다(400개 cluster 기준 밀리초 단위). 끄려면 TOPIC_MERGE_PREVIEW_ENABLED=false.
   */
  previewEnabled: parseBooleanEnv(process.env.TOPIC_MERGE_PREVIEW_ENABLED, true),

  /**
   * 계산된 병합을 실제 cluster에 적용할지. **기본 false를 유지한다.**
   * true로 바꾸는 것은 clustering 로직 변경이므로 사용자 승인 없이 하지 않는다.
   */
  applyToClusters: parseBooleanEnv(process.env.TOPIC_MERGE_APPLY, false),
} as const;

// 경쟁도 단계가 뽑아 둔 LLM 주제어를 다양성 선정(selectDiverseTopN)의 주제 동일성 판정에 쓸지.
//
// 왜 별도 게이트인가: 다양성/선정 로직 변경은 CLAUDE.md "승인 없이는 금지" 항목이다. 그래서
// 기본은 **preview만**이다 - 켰을 때 Top N이 어떻게 달라지는지 로그로만 남기고 실제 선정은
// 기존 규칙(topicGrouping.isSameTopic)을 그대로 쓴다. 근거와 실측은 topicQueryMatch.ts 상단.
export const DIVERSITY_TOPIC_QUERY_CONFIG = {
  /**
   * 켰을 때의 Top N을 함께 계산해 로그로 남길지. 순수 함수 두 번 호출이라 비용이 사실상 없다.
   * 끄려면 DIVERSITY_TOPIC_QUERY_PREVIEW=false.
   */
  previewEnabled: parseBooleanEnv(process.env.DIVERSITY_TOPIC_QUERY_PREVIEW, true),

  /**
   * 실제 선정에 적용할지. **기본 false를 유지한다.** 사용자 승인 없이 켜지 않는다.
   */
  enabled: parseBooleanEnv(process.env.DIVERSITY_TOPIC_QUERY_ENABLED, false),
} as const;
