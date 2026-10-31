// 채널별 **최소 발행 간격**(2026-11-01 사용자 지시, 기본 5분).
//
// 왜 필요한가:
//  · 2026-10-31 23:47에 티스토리로 두 건을 연달아 올린 직후, 7번째 발행에서 **카카오 캡차**가 떴다
//    (`capcha_layer` + `dkaptcha.kakao.com`). 폴러는 캡차를 풀 수 없어 30초 대기 후 실패했고, 사용자가
//    직접 발행해야 했다. 연속 발행을 플랫폼이 자동화로 본 것이다.
//  · 더 큰 이유는 네이버다 - **자동 발행으로 저품질 판정을 받은 이력이 있다**(사용자). 짧은 간격의 연속
//    발행은 그 판정을 부르는 대표적 패턴이라, 캡차보다 회복 비용이 훨씬 크다.
//
// 그래서 폴러가 발행을 집기 전에 "그 채널의 **마지막 성공 발행**으로부터 N분이 지났는가"를 본다.
// 안 지났으면 **실패가 아니라 미룸**이다 - 요청을 그대로 두고 다음 주기(60초)에 다시 본다. 사용자가 누른
// 버튼은 살아 있고, 알림도 보내지 않는다(60초마다 알림이 오면 소음이다).
//
// 한 주기에 한 건만 올리는 기존 `MAX_PER_RUN=1`과 짝을 이룬다 - 그것만으로는 60초 간격이 전부였다.
//
// 순수 함수 + 저장소 조회 한 번이다.

import { supabase } from "../../services/supabase/client.js";

/** 채널 이름(publications.platform과 같다). */
export type PublishPlatform = "tistory" | "naver" | "blogspot";

/** 기본 5분. 사용자가 정한 하한이다 - 더 줄이려면 그 사람의 결정이 필요하다. */
export const DEFAULT_MIN_INTERVAL_MINUTES = 5;

const ENV_KEY: Record<PublishPlatform, string> = {
  tistory: "TISTORY_PUBLISH_MIN_INTERVAL_MIN",
  naver: "NAVER_PUBLISH_MIN_INTERVAL_MIN",
  blogspot: "BLOGSPOT_PUBLISH_MIN_INTERVAL_MIN",
};

/**
 * 설정된 간격(분). 음수·숫자 아님은 기본값으로 떨어뜨린다. **0은 허용한다** - 끄고 싶을 때 쓰는 값이고,
 * 끄는 것은 사용자 결정이라 코드가 막지 않는다(다만 기본은 켜짐이다).
 */
export function minIntervalMinutes(platform: PublishPlatform, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_KEY[platform]]?.trim();
  if (!raw) return DEFAULT_MIN_INTERVAL_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_INTERVAL_MINUTES;
  return parsed;
}

export type IntervalGate =
  | { allowed: true }
  | { allowed: false; waitMs: number; lastPublishedAt: string; reason: string };

/**
 * 마지막 성공 발행 시각으로 간격을 판정한다. 시각을 모르면(기록 없음·파싱 실패) **통과**시킨다 -
 * 모르는 것 때문에 발행을 막지 않는다.
 */
export function checkInterval(
  lastPublishedAt: string | null,
  platform: PublishPlatform,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): IntervalGate {
  const minutes = minIntervalMinutes(platform, env);
  if (minutes <= 0 || !lastPublishedAt) return { allowed: true };

  const last = Date.parse(lastPublishedAt);
  if (Number.isNaN(last)) return { allowed: true };

  const elapsed = now.getTime() - last;
  const required = minutes * 60_000;
  // 미래 시각(시계 어긋남)은 통과시킨다 - 영원히 막히는 쪽이 더 위험하다.
  if (elapsed < 0 || elapsed >= required) return { allowed: true };

  const waitMs = required - elapsed;
  return {
    allowed: false,
    waitMs,
    lastPublishedAt,
    reason: `${platform} 마지막 발행에서 ${Math.floor(elapsed / 60_000)}분 지남 - 최소 ${minutes}분 간격까지 ${Math.ceil(waitMs / 60_000)}분 남음`,
  };
}

/** 그 채널의 가장 최근 성공 발행 시각. 없으면 null. */
export async function lastPublishedAtFor(platform: PublishPlatform): Promise<string | null> {
  const { data, error } = await supabase
    .from("publications")
    .select("published_at")
    .eq("platform", platform)
    .eq("status", "published")
    .not("published_at", "is", null)
    .order("published_at", { ascending: false })
    .limit(1);
  if (error) {
    // 조회 실패로 발행을 막지 않는다 - 간격 가드는 보호 장치지 관문이 아니다.
    console.warn(`⚠️ [publish-interval] 마지막 발행 시각 조회 실패(간격 검사를 건너뜁니다): ${error.message}`);
    return null;
  }
  return (data?.[0]?.published_at as string | undefined) ?? null;
}

/** 폴러가 쓰는 한 줄짜리 판정. 조회 + 판정. */
export async function publishIntervalGate(
  platform: PublishPlatform,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): Promise<IntervalGate> {
  return checkInterval(await lastPublishedAtFor(platform), platform, now, env);
}
