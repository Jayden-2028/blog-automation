// 멀티봇 공통 레이어(telegramTracks.ts) 테스트. 네트워크·DB 없음 - env는 주입한다.
import { TRACKS, DEFAULT_TRACK, TRACK_ENV_KEYS, parseTrack, resolveTrackCredentials, trackJobMetadata, trackOfJob } from "./telegramTracks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 1) parseTrack
assert(parseTrack("social") === "social", "social 파싱");
assert(parseTrack("kscene") === "kscene", "kscene 파싱");
assert(parseTrack("blog") === null && parseTrack(undefined) === null && parseTrack(3) === null, "모르는 값은 null");
console.log("✅ parseTrack");

// 2) trackOfJob - 값 없음/모르는 값은 엔터(개편 전 job 하위 호환)
assert(trackOfJob({ metadata: {} }) === DEFAULT_TRACK, "metadata.track 없음 -> 엔터");
assert(trackOfJob({ metadata: { track: "social" } }) === "social", "metadata.track=social");
assert(trackOfJob({ metadata: { track: "unknown" } }) === DEFAULT_TRACK, "모르는 값은 던지지 않고 엔터");
assert(trackOfJob(null) === DEFAULT_TRACK && trackOfJob(undefined) === DEFAULT_TRACK, "job이 없어도 엔터");
console.log("✅ trackOfJob - 하위 호환");

// 3) trackJobMetadata - 엔터는 비워 둔다
assert(Object.keys(trackJobMetadata("entertainment")).length === 0, "엔터는 metadata를 건드리지 않는다");
assert(trackJobMetadata("social").track === "social", "사회는 track을 새긴다");
console.log("✅ trackJobMetadata");

// 4) resolveTrackCredentials - 트랙별 env, 다른 트랙으로 대신하지 않는다
const env = {
  TELEGRAM_BOT_TOKEN: "main-token",
  TELEGRAM_CHAT_ID: "1",
  SOCIAL_TELEGRAM_BOT_TOKEN: "social-token",
  SOCIAL_TELEGRAM_CHAT_ID: "2",
};
assert(resolveTrackCredentials("entertainment", env).botToken === "main-token", "엔터는 메인봇");
assert(resolveTrackCredentials("social", env).botToken === "social-token", "사회는 사회 봇");
assert(resolveTrackCredentials(undefined, env).botToken === "main-token", "생략하면 메인봇(기존 호출부 호환)");

let threw = false;
try {
  resolveTrackCredentials("kscene", env); // KSCENE_* 없음
} catch (error) {
  threw = true;
  const message = error instanceof Error ? error.message : "";
  assert(message.includes("KSCENE_TELEGRAM_BOT_TOKEN"), "오류에 빠진 변수 이름이 있어야 한다");
  assert(!message.includes("main-token"), "오류 메시지에 토큰 값이 새면 안 된다");
}
assert(threw, "자격증명이 없으면 메인봇으로 대신하지 말고 던져야 한다");

let threwPartial = false;
try {
  resolveTrackCredentials("social", { SOCIAL_TELEGRAM_BOT_TOKEN: "x" }); // chatId 없음
} catch {
  threwPartial = true;
}
assert(threwPartial, "토큰만 있고 채팅 ID가 없어도 던져야 한다");
console.log("✅ resolveTrackCredentials - 트랙별 해석, 오배송 대신 실패");

// 5) 모든 트랙에 env 키가 있다(트랙을 늘리고 표를 빼먹는 실수 방지)
for (const track of TRACKS) {
  assert(TRACK_ENV_KEYS[track].botToken && TRACK_ENV_KEYS[track].chatId, `${track} env 키 누락`);
}
console.log("✅ 모든 트랙에 env 키 정의");

console.log("\n✅ testTelegramTracks 전체 통과");
