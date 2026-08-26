// NAVER Creator Advisor 트렌드 탭을 동적 키워드 소스로 쓰기 위한 설정.
// keywordScoring.ts와 동일하게, 로직 코드(BrowserCreatorAdvisorProvider 등)에는 숫자/문자열을
// 흩뿌리지 않고 이 파일만 참조한다.
//
// enabled 기본값은 반드시 false여야 한다: Creator Advisor는 (1) 비공식 페이지 스크래핑이라 페이지
// 구조 변경에 취약하고 (2) 사람이 최초 1회 수동 로그인해야 하는 persistent profile에 의존하므로,
// 이 두 조건이 갖춰지기 전까지는 daily workflow가 이 소스 없이도 seed_queries만으로 정상 동작해야 한다.
// (buildDailyQueryPool.ts 참고)

export type CreatorAdvisorConfig = {
  /** true여야 daily query pool이 trend_candidates를 실제로 사용한다. 기본 false. */
  enabled: boolean;
  /**
   * Creator Advisor에 연동된 네이버 블로그 ID. trends 페이지 URL이
   * `https://creator-advisor.naver.com/naver_blog/{blogId}/trends` 형태로 이 값에 고정되어 있어서
   * (topic은 더 이상 URL query param이 아니라 페이지 내 탭 클릭으로 전환한다), 비어 있으면
   * BrowserCreatorAdvisorProvider가 동작할 수 없다.
   */
  blogId: string;
  /**
   * trends 페이지에서 수집할 최대 topic card 개수(Swiper 슬라이드 = topic 1개).
   * topic은 더 이상 이름으로 지정하지 않는다 - 페이지가 주는 순서대로 앞에서부터 이 개수만큼 수집한다.
   */
  maxTopics: number;
  /** topic 하나당 저장할 최대 키워드 개수. */
  maxKeywordsPerTopic: number;
  /** (다음 단계용, 현재 미사용) Swiper 순회 구현 시 슬라이드 전환 사이에 둘 지연 시간(ms). */
  requestDelayMs: number;
  /** trend_candidates row의 기본 유효 기간(시간). 수집 시 expires_at = collected_at + candidateTtlHours. */
  candidateTtlHours: number;
  /** Playwright persistent context가 세션(쿠키/로그인 상태)을 저장할 디렉터리. .gitignore 처리됨. */
  profileDir: string;
  /** 기존에 쓰던 일반 Chrome 프로필과 절대 공유하지 않는다 — Creator Advisor 전용 profile만 사용. */

  /**
   * Daily Query Pool에 투입할 Creator Advisor 후보의 최대 개수(creatorAdvisorMaxDailyCandidates).
   * 120개 전부를 NAVER API 검증에 보내지 않기 위한 1차 선별 상한이며, selectTopCreatorAdvisorCandidates()가
   * candidate_score + topic diversity 기준으로 이 개수만큼 고른다.
   */
  maxDailyCandidates: number;
  /** 위 선택에서 topic 하나가 차지할 수 있는 최대 개수(편중 방지). */
  maxCandidatesPerTopic: number;
};

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const CREATOR_ADVISOR_CONFIG: CreatorAdvisorConfig = {
  enabled: parseBooleanEnv(process.env.CREATOR_ADVISOR_ENABLED, false),
  blogId: process.env.CREATOR_ADVISOR_BLOG_ID ?? "",
  maxTopics: parseIntEnv(process.env.CREATOR_ADVISOR_MAX_TOPICS, 4),
  maxKeywordsPerTopic: parseIntEnv(process.env.CREATOR_ADVISOR_MAX_KEYWORDS_PER_TOPIC, 20),
  requestDelayMs: parseIntEnv(process.env.CREATOR_ADVISOR_REQUEST_DELAY_MS, 2000),
  candidateTtlHours: parseIntEnv(process.env.CREATOR_ADVISOR_CANDIDATE_TTL_HOURS, 24),
  profileDir: process.env.CREATOR_ADVISOR_PROFILE_DIR ?? ".local/creator-advisor-profile",
  maxDailyCandidates: parseIntEnv(process.env.CREATOR_ADVISOR_MAX_DAILY_CANDIDATES, 40),
  maxCandidatesPerTopic: parseIntEnv(process.env.CREATOR_ADVISOR_MAX_CANDIDATES_PER_TOPIC, 6),
};
