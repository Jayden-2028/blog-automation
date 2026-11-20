// webhook 경로 -> 트랙 테스트. Worker 사본(track.ts)이 본 코드(telegramTracks.ts)와 어긋나지 않는지도 본다.
import { RELAY_BOT_TOKEN_KEYS, RELAY_TRACKS, forwardsCaptionMessages, forwardsPlainMessages, trackFromPath } from "./track.js";
import type { RelayTrack } from "./track.js";
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

// 사본이 본 코드와 같다(잡 트랙은 전부 Worker 경로에 있어야 하고, 토큰 이름도 같아야 한다). instagram은 봇 경로만 있다.
// scenepick(2026-11-21)은 사회 봇을 같이 쓴다 - 자기 webhook 경로가 없고, 같은 봇 토큰을 쓰는 경로(사회)가 있으면 된다.
for (const track of TRACKS) {
  if (!(RELAY_TRACKS as readonly string[]).includes(track)) {
    const sharing = RELAY_TRACKS.find((relay) => RELAY_BOT_TOKEN_KEYS[relay] === TRACK_ENV_KEYS[track].botToken);
    assert(sharing, `Worker 경로에 ${track}이 없고, 같은 봇을 쓰는 경로도 없다`);
    continue;
  }
  assert(RELAY_BOT_TOKEN_KEYS[track as RelayTrack] === TRACK_ENV_KEYS[track].botToken, `${track} 봇 토큰 이름이 Worker와 본 코드에서 다르다`);
}
assert(trackFromPath("/webhook/scenepick") === null, "scenepick은 새 webhook 경로가 없다(사회 봇 /webhook/social로 들어온다)");
assert(RELAY_TRACKS.every((t) => forwardsPlainMessages(t)), "일반 글자 메시지는 인스타·사회·엔터·국제 봇 모두 넘긴다(엔터·국제는 2026-11-21 주제 직접 입력)");
assert(forwardsCaptionMessages("instagram") && !forwardsCaptionMessages("social") && !forwardsCaptionMessages("entertainment") && !forwardsCaptionMessages("kscene"), "캡션 메시지는 인스타 봇만");
assert(trackFromPath("/webhook/instagram") === "instagram" && RELAY_BOT_TOKEN_KEYS.instagram === "INSTAGRAM_BOT_TOKEN", "instagram 봇 경로");
console.log("✅ Worker 사본이 telegramTracks.ts와 일치 (+instagram 봇 경로)");

console.log("\n✅ testTrack 전체 통과");
