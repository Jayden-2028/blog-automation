// webhook 경로 -> 트랙. 봇마다 setWebhook이 가리키는 경로가 다르다(RESTRUCTURE-PLAN-2026-10.md §3.1).
// 순수 함수라 Worker 밖(tsx 테스트)에서도 검증한다.
//
// 트랙 목록은 src/notifications/telegramTracks.ts의 TRACKS와 **같아야 한다**(단 다른 트랙의 봇을 같이 쓰는 트랙 - scenepick은
// 사회 봇 - 은 자기 경로가 없다. testTrack.ts가 그 경우 봇 토큰 이름이 같은 경로가 있는지만 본다) - Worker 번들이 저장소 루트
// src/를 import하지 않게 해 둔 터라 여기에 사본을 둔다. testTrack.ts가 둘이 어긋나면 실패하게 한다.

// instagram(2026-10-06): 인스타 변환기 봇. 잡 트랙이 아니라 **봇 경로**다 - 잡은 사용자가 버튼으로 고른 트랙(엔터/사회)을
// 따른다. 이 봇은 링크(일반 메시지)도 받아야 하므로 index.ts가 답장이 아닌 메시지도 넘긴다.
export const RELAY_TRACKS = ["entertainment", "social", "kscene", "instagram"] as const;
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
  instagram: "INSTAGRAM_BOT_TOKEN",
};

/**
 * 이 경로는 답장이 아닌 일반 메시지(링크)도 GitHub Actions로 넘긴다.
 * 사회 봇(2026-11-21 사용자 결정): 일반 메시지 = scenepick 새 주제 발주다(runTelegramUpdateCli -> handleScenepickTopic).
 * scenepick은 사회 봇을 같이 쓰므로 별도 경로(/webhook/scenepick)를 만들지 않는다.
 * 엔터·국제 봇(2026-11-21 사용자 결정): 일반 글자 메시지 = 새 주제 직접 입력(runTelegramUpdateCli -> topic-intake). 엔터 봇은 [엔터][인물]
 * 버튼을 묻고, 국제 봇은 바로 국제 원고를 발주한다. 모든 봇이 글자 메시지를 넘기게 된다(사진·영상 등 글자 없는 update는 index.ts가 버린다).
 */
export function forwardsPlainMessages(track: RelayTrack): boolean {
  return track === "instagram" || track === "social" || track === "entertainment" || track === "kscene";
}

/** 사진·영상에 캡션으로 붙은 글자도 넘기는가. 인스타 봇만(링크가 캡션으로 온다 - 개편2.5 C-1). 사회 봇은 글자 메시지만 주제다. */
export function forwardsCaptionMessages(track: RelayTrack): boolean {
  return track === "instagram";
}
