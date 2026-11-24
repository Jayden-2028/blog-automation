// 엔터 키워드 수집의 "하루 창" 설정(2026-11-25, 사용자 지시 - docs/ai-handoff/ENT_DAILY_WINDOW_2026-11-25.md).
//
// 엔터 수집(entertainment-keyword.yml, 18:00 KST 1회)에서만 쓴다. 사회·사용설명서 트랙과 자료조사
// 수집(collectSourcesForJob)은 이 설정을 받지 않으므로 기존대로 검색어당 10건이다.
//
// 세 값 모두 repo variable(워크플로 env)로 코드 변경 없이 조절한다. **ENT_NAVER_WINDOW_HOURS=0이면
// 하루 창 전체(페이지네이션 + 점수 프로필 + 진단 로그)가 꺼지고 2026-11-24까지의 동작으로 돌아간다.**

import { buildDailyWindowScoringProfile, type KeywordScoringProfile } from "./keywordScoring.js";

export const ENT_NAVER_WINDOW_HOURS_ENV = "ENT_NAVER_WINDOW_HOURS";
export const ENT_NAVER_MAX_NEWS_PER_QUERY_ENV = "ENT_NAVER_MAX_NEWS_PER_QUERY";
export const ENT_NAVER_MAX_BLOG_PER_QUERY_ENV = "ENT_NAVER_MAX_BLOG_PER_QUERY";
export const ENT_NAVER_MAX_CALLS_ENV = "ENT_NAVER_MAX_CALLS";

export const ENT_DAILY_WINDOW_DEFAULTS = {
  /** 수집 창(시간). 실행 시각 기준 과거 24시간. */
  windowHours: 24,
  /**
   * 검색어당 뉴스 상한(3쪽). "캐스팅"·"넷플릭스" 같은 넓은 시드가 하루 수백 건을 내도 여기서 멈춘다.
   * 좁은 시드(그날의 사건명)는 대개 1쪽 안에서 창이 끝나 상한까지 가지 않는다.
   */
  maxNewsPerQuery: 300,
  /**
   * 검색어당 블로그 상한(1쪽). 뉴스보다 낮게 둔 이유 셋:
   * ① 블로그 postdate는 날짜까지만 있어 18시 실행이면 창이 사실상 어제 0시부터 ~42시간이다
   *    (naverDailyWindow.blogWindowVerdict) - 넓은 시드는 매번 상한까지 찬다.
   * ② 블로그는 점수에서 contentDemand(블로그+웹 20건이면 절대 신호 만점)·crossSource에만 들어가
   *    100건 이상은 점수를 바꾸지 못한다.
   * ③ 대부분 경쟁 블로그의 SEO 글이라(KEYWORD-ENT-REDESIGN-2026-11.md §1-A) 후보 수만 키워
   *    clustering 비용(O(n²))을 늘린다.
   */
  maxBlogPerQuery: 100,
  /**
   * 뉴스+블로그 검색 호출 상한(1회 실행). 첫 페이지(검색어×2)는 항상 보장하고 추가 페이지만 이 안에서
   * 허용한다. 시드 ~65개 기준 최악은 65×2 + 65×(뉴스 추가 2쪽) = 260회라 평소엔 닿지 않는 안전판이다.
   * 네이버 검색 API 일 25,000회 한도는 다른 잡(자료조사·경쟁도 프로브)과 공유한다.
   */
  maxCalls: 500,
} as const;

function parseNumberEnv(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type EntDailyWindowConfig = {
  windowHours: number;
  maxNewsPerQuery: number;
  maxBlogPerQuery: number;
  maxCalls: number;
  /** 6-factor 중 freshness·newsVelocity의 하루 창 프로필. 엔터 경로에서만 scoreKeyword에 넘긴다. */
  scoringProfile: KeywordScoringProfile;
  /** 실행 로그에 항목별 점수를 남길 상위 개수. */
  diagnosticTopN: number;
};

/**
 * env를 읽어 하루 창 설정을 만든다. 미설정·빈 값·숫자 아님은 기본값이고, windowHours가 0 이하면
 * null = 하루 창을 쓰지 않는다(롤백 스위치).
 */
export function resolveEntDailyWindowConfig(env: NodeJS.ProcessEnv = process.env): EntDailyWindowConfig | null {
  const windowHours = parseNumberEnv(env[ENT_NAVER_WINDOW_HOURS_ENV], ENT_DAILY_WINDOW_DEFAULTS.windowHours);
  if (windowHours <= 0) return null;

  const positiveInt = (value: number, fallback: number) => (value >= 1 ? Math.floor(value) : fallback);

  return {
    windowHours,
    maxNewsPerQuery: positiveInt(
      parseNumberEnv(env[ENT_NAVER_MAX_NEWS_PER_QUERY_ENV], ENT_DAILY_WINDOW_DEFAULTS.maxNewsPerQuery),
      ENT_DAILY_WINDOW_DEFAULTS.maxNewsPerQuery
    ),
    maxBlogPerQuery: positiveInt(
      parseNumberEnv(env[ENT_NAVER_MAX_BLOG_PER_QUERY_ENV], ENT_DAILY_WINDOW_DEFAULTS.maxBlogPerQuery),
      ENT_DAILY_WINDOW_DEFAULTS.maxBlogPerQuery
    ),
    maxCalls: positiveInt(
      parseNumberEnv(env[ENT_NAVER_MAX_CALLS_ENV], ENT_DAILY_WINDOW_DEFAULTS.maxCalls),
      ENT_DAILY_WINDOW_DEFAULTS.maxCalls
    ),
    scoringProfile: buildDailyWindowScoringProfile(windowHours),
    diagnosticTopN: 50,
  };
}
