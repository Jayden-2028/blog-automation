// Daily Query Pool에 투입할 동적 키워드 소스(trend_candidates.source)별 설정.
//
// 왜 별도 파일인가: creatorAdvisor.ts는 "Creator Advisor 크롤러를 어떻게 돌릴지"(blogId, profileDir,
// swiper 순회 등)를 담고 있고, 이 파일은 "여러 소스를 daily pool에 어떤 비율로 섞을지"를 담는다.
// 관심사가 다르고, 소스가 늘어날수록 후자만 계속 커진다.
//
// 스키마 변경이 필요 없다는 점이 이 설계의 전제다: trend_candidates의 unique index가 이미
// (keyword_normalized, topic_normalized, trend_date, source)이고 source는 text 컬럼이라,
// 새 소스는 문자열 하나만 추가하면 되고 migration이 필요 없다.
//
// enabled 기본값은 creator_advisor를 제외하고 전부 false다. 신규 소스는 (1) 외부 페이지 구조에
// 의존하거나 (2) 아직 실측 검증이 끝나지 않았으므로, 켜는 것은 명시적 선택이어야 한다 -
// buildDailyQueryPool은 어떤 소스가 꺼져 있거나 실패해도 나머지로 정상 동작한다.

import { CREATOR_ADVISOR_CONFIG } from "./creatorAdvisor.js";

/** trend_candidates.source에 저장되는 값. 새 소스를 추가할 때 여기부터 늘린다. */
export const TREND_SOURCES = [
  "creator_advisor",
  "google_trends",
  "daum_realtime",
  "community",
] as const;
export type TrendSource = (typeof TREND_SOURCES)[number];

export type TrendSourceConfig = {
  /** false면 buildDailyQueryPool이 이 소스를 조회조차 하지 않는다. */
  enabled: boolean;
  /** 이 소스가 daily query pool에 넣을 수 있는 최대 키워드 수. */
  maxDailyCandidates: number;
  /**
   * 이 소스 안에서 topic 하나가 차지할 수 있는 최대 개수(편중 방지).
   * topic 구분이 없는 소스(구글 트렌드처럼 순위 목록 하나만 주는 경우)는 maxDailyCandidates와 같게
   * 두면 사실상 "점수 상위 N개"가 된다 - selectTopCreatorAdvisorCandidates의 round-robin이
   * topic 1개짜리 입력에서 자연스럽게 그렇게 동작한다.
   */
  maxCandidatesPerTopic: number;
  /** trend_candidates row의 유효 기간(시간). 수집 시 expires_at = collected_at + 이 값. */
  candidateTtlHours: number;
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

// quota 근거(2026-08-29): 현재 pool은 seed 44 + CA 40 = 84 query이고 collect 단계가 약 70초다.
// query 수에 비례해 늘어나므로(query당 NAVER API 3회 순차 호출) 신규 소스 30건을 더하면 약 90초,
// 전체 약 105초가 된다. launchd + caffeinate 보호 범위 안이라 안전하다.
//
// CA 40을 줄이지 않은 이유: Creator Advisor는 "네이버 블로그에서 실제로 검색된 키워드"라 이 프로젝트의
// 발행 채널과 가장 직접적으로 연결된 신호다. 신규 소스는 그 사각지대(네이버 생태계 밖 화제)를
// 메우는 보강이지 대체가 아니다.
export const TREND_SOURCE_CONFIGS: Record<TrendSource, TrendSourceConfig> = {
  creator_advisor: {
    // 기존 CREATOR_ADVISOR_ENABLED를 그대로 따른다(별도 env를 새로 만들지 않는다).
    enabled: CREATOR_ADVISOR_CONFIG.enabled,
    maxDailyCandidates: CREATOR_ADVISOR_CONFIG.maxDailyCandidates,
    maxCandidatesPerTopic: CREATOR_ADVISOR_CONFIG.maxCandidatesPerTopic,
    candidateTtlHours: CREATOR_ADVISOR_CONFIG.candidateTtlHours,
  },
  google_trends: {
    enabled: parseBooleanEnv(process.env.GOOGLE_TRENDS_ENABLED, false),
    maxDailyCandidates: parseIntEnv(process.env.GOOGLE_TRENDS_MAX_DAILY_CANDIDATES, 10),
    maxCandidatesPerTopic: parseIntEnv(process.env.GOOGLE_TRENDS_MAX_DAILY_CANDIDATES, 10),
    // 구글 트렌드는 "지금 급상승"이라 수명이 짧다. CA(24h)보다 짧게 잡는다.
    candidateTtlHours: parseIntEnv(process.env.GOOGLE_TRENDS_CANDIDATE_TTL_HOURS, 12),
  },
  daum_realtime: {
    enabled: parseBooleanEnv(process.env.DAUM_REALTIME_ENABLED, false),
    maxDailyCandidates: parseIntEnv(process.env.DAUM_REALTIME_MAX_DAILY_CANDIDATES, 8),
    maxCandidatesPerTopic: parseIntEnv(process.env.DAUM_REALTIME_MAX_DAILY_CANDIDATES, 8),
    // 10분 주기로 갱신되는 실시간 순위라 가장 짧다.
    candidateTtlHours: parseIntEnv(process.env.DAUM_REALTIME_CANDIDATE_TTL_HOURS, 8),
  },
  community: {
    enabled: parseBooleanEnv(process.env.COMMUNITY_TRENDS_ENABLED, false),
    maxDailyCandidates: parseIntEnv(process.env.COMMUNITY_TRENDS_MAX_DAILY_CANDIDATES, 12),
    // 커뮤니티는 사이트별로 성격이 달라 topic(=사이트)당 상한을 둔다. 한 사이트가 독식하면
    // 그 사이트의 편향이 그대로 daily pool의 편향이 된다.
    maxCandidatesPerTopic: parseIntEnv(process.env.COMMUNITY_TRENDS_MAX_CANDIDATES_PER_SITE, 4),
    candidateTtlHours: parseIntEnv(process.env.COMMUNITY_TRENDS_CANDIDATE_TTL_HOURS, 18),
  },
};

/** enabled=true인 source만 순서대로 반환한다. */
export function getEnabledTrendSources(): TrendSource[] {
  return TREND_SOURCES.filter((source) => TREND_SOURCE_CONFIGS[source].enabled);
}
