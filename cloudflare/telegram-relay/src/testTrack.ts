// webhook 경로 -> 트랙 테스트. Worker 사본(track.ts)이 본 코드(telegramTracks.ts)와 어긋나지 않는지도 본다.
import { RELAY_BOT_TOKEN_KEYS, RELAY_TRACKS, trackFromPath } from "./track.js";
import { TRACKS, TRACK_ENV_KEYS } from "../../../src/notifications/telegramTracks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 개편 전 메인봇 webhook(Worker 루트)이 그대로 엔터여야 재등록 없이 동작한다.
assert(trackFromPath("/") === "entertainment", "루트는 엔터(기존 webhook 호환)");
assert(trackFromPath("") === "entertainment", "빈 경로는 엔터");
assert(trackFromPath("/webhook") === "entertainment", "/webhook은 엔터");
assert(trackFromPath("/webhook/entertainment") === "entertainment", "/webhook/entertainment");
assert(trackFromPath("/webhook/social") === "social", "/webhook/social");
assert(trackFromPath("/webhook/social/") === "social", "끝 슬래시 허용");
assert(trackFromPath("/webhook/kscene") === "kscene", "/webhook/kscene");
assert(trackFromPath("/webhook/unknown") === null, "모르는 트랙은 null(404)");
assert(trackFromPath("/webhook/social/extra") === null, "하위 경로는 null");
assert(trackFromPath("/admin") === null, "관계없는 경로는 null");
console.log("✅ trackFromPath");

// 사본이 본 코드와 같다.
assert(JSON.stringify([...RELAY_TRACKS]) === JSON.stringify([...TRACKS]), "RELAY_TRACKS가 TRACKS와 달라졌다 - 두 곳을 같이 고칠 것");
for (const track of TRACKS) {
  assert(RELAY_BOT_TOKEN_KEYS[track] === TRACK_ENV_KEYS[track].botToken, `${track} 봇 토큰 이름이 Worker와 본 코드에서 다르다`);
}
console.log("✅ Worker 사본이 telegramTracks.ts와 일치");

console.log("\n✅ testTrack 전체 통과");
