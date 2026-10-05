// 멀티봇 공통 레이어(telegramTracks.ts) 테스트. 네트워크·DB 없음 - env는 주입한다.
import { TRACKS, DEFAULT_TRACK, TRACK_ENV_KEYS, isChannelAllowedForTrack, parseTrack, pickJobForTrack, publishActionRowsForTrack, resolveTrackCredentials, trackJobMetadata, trackOfJob } from "./telegramTracks.js";

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

// 4-b) 답장 매칭 - message_id가 같은 job이 트랙별로 있어도 그 트랙 것만(개편2.5 A-3)
const entJob = { id: "ent", metadata: {} };
const legacyJob = { id: "legacy", metadata: { editRequestMessageId: 5 } };
const socialJob = { id: "soc", metadata: { track: "social" } };
const rows = [socialJob, entJob, legacyJob]; // 최신순
assert(pickJobForTrack(rows, "social")?.id === "soc", "사회 봇 답장 -> 사회 job");
assert(pickJobForTrack(rows, "entertainment")?.id === "ent", "엔터 봇 답장 -> 엔터 job(사회 job이 더 최신이어도)");
assert(pickJobForTrack([legacyJob], "entertainment")?.id === "legacy", "track 없는 옛 레코드는 엔터로 매칭(호환)");
assert(pickJobForTrack([entJob], "social") === null, "사회 봇이 엔터 job만 있는 번호에 답장 -> 매칭 없음");
assert(pickJobForTrack(rows)?.id === "soc", "track을 안 주면 예전처럼 첫 job");
assert(pickJobForTrack([], "social") === null, "빈 목록");
console.log("✅ pickJobForTrack - 답장 매칭 트랙 분기");

// 4-c) 트랙-채널 검증·대체 키보드(개편2.5 B-2)
assert(isChannelAllowedForTrack("entertainment", "naver") && !isChannelAllowedForTrack("entertainment", "tistory"), "엔터: 네이버 허용, 티스토리 거부");
assert(isChannelAllowedForTrack("social", "tistory") && !isChannelAllowedForTrack("social", "naver") && !isChannelAllowedForTrack("social", "blogspot"), "사회: 티스토리만");
const flat = (t: "entertainment" | "social" | "kscene") => publishActionRowsForTrack(t).flat();
assert(flat("entertainment").includes("naver") && !flat("entertainment").includes("blogspot") && !flat("entertainment").includes("tistory"), "엔터 키보드 = 네이버만(블로그스팟·티스토리 없음)");
assert(flat("social").includes("tistory") && !flat("social").includes("naver") && !flat("social").includes("blogspot"), "사회 키보드 = 티스토리만");
assert(flat("social").includes("images") && flat("social").includes("export"), "공통 버튼 유지");
console.log("✅ 트랙-채널 검증 / 트랙별 대체 키보드");

// 5) 모든 트랙에 env 키가 있다(트랙을 늘리고 표를 빼먹는 실수 방지)
for (const track of TRACKS) {
  assert(TRACK_ENV_KEYS[track].botToken && TRACK_ENV_KEYS[track].chatId, `${track} env 키 누락`);
}
console.log("✅ 모든 트랙에 env 키 정의");

console.log("\n✅ testTelegramTracks 전체 통과");
