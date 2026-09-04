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

  /** 프로브를 돌릴 최대 키워드 수. daily workflow는 최종 Top 10이라 실제로는 10건이다. */
  probeMaxKeywords: parseIntEnv(process.env.BLOG_COMPETITION_PROBE_MAX, 30),

  /** 프로브 호출 사이 지연(ms). rate limit 보호. 기존 provider들과 같은 값. */
  requestDelayMs: parseIntEnv(process.env.BLOG_COMPETITION_DELAY_MS, 150),

  /**
   * 포화도 정규화 구간(블로그 문서 총 수). log10 스케일로 보간한다.
   * total <= low  -> saturation 0 (공급 희소 = 선점 기회)
   * total >= high -> saturation 1 (포화)
   *
   * ⚠️ 아래 값은 **잠정치**다. Phase A 관측 전까지 근거가 없으므로 점수에 반영하지 않는다
   * (applyToScore=false). 관측 리포트(debug:blog-competition)가 실제 분포를 출력하면
   * 그 분포를 보고 확정한다.
   */
  lowTotalThreshold: parseIntEnv(process.env.BLOG_COMPETITION_LOW_TOTAL, 300),
  highTotalThreshold: parseIntEnv(process.env.BLOG_COMPETITION_HIGH_TOTAL, 50000),

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
