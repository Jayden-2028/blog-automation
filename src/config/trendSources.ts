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
// enabled 기본값은 소스마다 다르고, 기준은 "사람의 사전 준비 없이 혼자 도는가"다.
// - google_trends: 기본 true. 인증도 브라우저도 로그인 프로필도 필요 없고, 2026-08-29에 실측
//   검증을 마쳤다(KR TOP 10 정상 응답 + 분류 확인). 켜두는 것이 기본이고 끄는 것이 예외다.
// - creator_advisor: 기본 false. 사람이 최초 1회 수동 로그인한 persistent profile에 의존하므로,
//   준비가 안 된 환경에서 켜지면 매일 실패한다.
// - community: 기본 true. 더쿠(theqoo.net/hot)만 붙어 있고 robots.txt 실측상 허용, 인증/프로필
//   불필요, 2026-08-30에 맥에서 dry-run fetch 20건 실측 검증. 켜두는 것이 기본, 끄려면
//   COMMUNITY_TRENDS_ENABLED=false. 사이트 하나가 막혀도 runCommunityCollection이 격리한다.
// - daum_realtime: 기본 false. 아직 수집기가 구현되지 않았다.
// 어느 쪽이든 buildDailyQueryPool은 소스가 꺼져 있거나 실패해도 나머지로 정상 동작한다.

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
    // 기본 true(2026-08-29 사용자 승인 + 실측 검증 완료). 끄려면 GOOGLE_TRENDS_ENABLED=false.
    enabled: parseBooleanEnv(process.env.GOOGLE_TRENDS_ENABLED, true),
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
    // 기본 true(2026-08-30 사용자 승인 + 맥 dry-run 실측). 끄려면 COMMUNITY_TRENDS_ENABLED=false.
    enabled: parseBooleanEnv(process.env.COMMUNITY_TRENDS_ENABLED, true),
    // 2026-08-31: 커뮤니티는 이제 오후 13:00 전용 run의 유일한 소스라(오전 pool과 분리) 상한을
    // 12 -> 18로 올렸다. 관련성/클러스터링을 거치면 Top 10을 채우려면 후보가 넉넉해야 한다.
    maxDailyCandidates: parseIntEnv(process.env.COMMUNITY_TRENDS_MAX_DAILY_CANDIDATES, 18),
    // topic이 고정값("community")이라 per-topic sub-cap은 의미가 없다(google_trends와 동일 패턴).
    // daily와 같은 값으로 둔다. 사이트가 여럿 붙어 사이트별 다양성이 필요해지면 그때 도입한다.
    maxCandidatesPerTopic: parseIntEnv(process.env.COMMUNITY_TRENDS_MAX_DAILY_CANDIDATES, 18),
    candidateTtlHours: parseIntEnv(process.env.COMMUNITY_TRENDS_CANDIDATE_TTL_HOURS, 18),
  },
};

/**
 * 동적 소스에서 온 키워드의 최소 길이(공백 제거 기준). 이보다 짧으면 버린다.
 *
 * 왜 필요한가(2026-08-29 실측): 구글 트렌드 TOP 10에 "션"(가수 션)이 들어왔다. 1글자 키워드는
 * 단순히 검색 품질이 나쁜 정도가 아니라 **관련성 필터를 통째로 무력화한다**:
 *   textNormalize.tokenize()가 CLUSTERING_CONFIG.minTokenLength(2) 미만 토큰을 버린다
 *   -> 1글자 seed는 토큰이 0개
 *   -> computeSeedRelevance가 SEED_RELEVANCE_CONFIG.neutralRelevanceWhenSeedTooShort(0.7)를 반환
 *   -> minRelevanceThreshold(0.25)를 넘어 **그 seed에서 나온 후보가 전부 통과**
 * 즉 1글자 키워드 하나가 relevance 게이트를 열어 무관한 후보 수십 건을 clustering까지 밀어 넣는다.
 * seed_queries는 사람이 큐레이션하므로 이런 값이 없지만, 동적 소스는 무엇이든 줄 수 있다.
 */
export const MIN_TREND_KEYWORD_LENGTH = 2;

/**
 * 이 키워드를 daily pool에 넣어도 되는지. 지금은 최소 길이 하나만 본다.
 * 구글 트렌드/커뮤니티 등 사람이 큐레이션하지 않는 모든 동적 소스가 공유한다(MIN_TREND_KEYWORD_LENGTH 주석).
 */
export function isUsableTrendKeyword(keyword: string): boolean {
  return keyword.replace(/\s+/g, "").length >= MIN_TREND_KEYWORD_LENGTH;
}

/** enabled=true인 source만 순서대로 반환한다. */
export function getEnabledTrendSources(): TrendSource[] {
  return TREND_SOURCES.filter((source) => TREND_SOURCE_CONFIGS[source].enabled);
}
