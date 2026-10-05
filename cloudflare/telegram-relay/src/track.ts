// webhook 경로 -> 트랙. 봇마다 setWebhook이 가리키는 경로가 다르다(RESTRUCTURE-PLAN-2026-10.md §3.1).
// 순수 함수라 Worker 밖(tsx 테스트)에서도 검증한다.
//
// 트랙 목록은 src/notifications/telegramTracks.ts의 TRACKS와 **같아야 한다** - Worker 번들이 저장소 루트
// src/를 import하지 않게 해 둔 터라 여기에 사본을 둔다. testTrack.ts가 둘이 어긋나면 실패하게 한다.

export const RELAY_TRACKS = ["entertainment", "social", "kscene"] as const;
export type RelayTrack = (typeof RELAY_TRACKS)[number];

/**
 * 요청 경로로 트랙을 정한다. 알 수 없으면 null(호출자가 404).
 *
 * 메인봇은 개편 전부터 Worker 루트 URL(`/`)을 webhook으로 쓰고 있다 - **그 경로를 그대로 엔터로 받아야**
 * 개편 후에도 메인봇 webhook을 다시 등록하지 않아도 된다. `/webhook/entertainment`도 같은 뜻으로 받는다.
 */
export function trackFromPath(pathname: string): RelayTrack | null {
  const path = pathname.replace(/\/+$/, "");
  if (path === "" || path === "/webhook") return "entertainment";

  const match = /^\/webhook\/([a-z]+)$/.exec(path);
  if (!match) return null;
  return (RELAY_TRACKS as readonly string[]).includes(match[1]) ? (match[1] as RelayTrack) : null;
}

/** 트랙의 봇 토큰이 들어 있는 Worker secret 이름. */
export const RELAY_BOT_TOKEN_KEYS: Readonly<Record<RelayTrack, string>> = {
  entertainment: "TELEGRAM_BOT_TOKEN",
  social: "SOCIAL_TELEGRAM_BOT_TOKEN",
  kscene: "KSCENE_TELEGRAM_BOT_TOKEN",
};
