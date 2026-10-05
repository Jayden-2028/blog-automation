// 인스타 링크 트랙 선택 테스트(instagramTrack.ts). 실행: npm run test:ig-track
import { ackMessage, isBareTrackWord, resolveTrackReply, splitTrackWord, trackFromWord } from "./instagramTrack.js";
import type { InstagramQueueEntry } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const entry = (id: string, over: Partial<InstagramQueueEntry> = {}): InstagramQueueEntry =>
  ({ id, instagramUrl: `https://www.instagram.com/p/${id}/`, rawCaption: "", telegramChatId: "1", telegramMessageId: 1, receivedAt: "x", status: "needs_track", ...over }) as InstagramQueueEntry;

// 1) 단어 인식
assert(trackFromWord("엔터") === "entertainment" && trackFromWord("네이버") === "entertainment" && trackFromWord("연예") === "entertainment", "엔터 계열");
assert(trackFromWord("사회") === "social" && trackFromWord("티스토리") === "social" && trackFromWord("사회 이슈") === "social", "사회 계열");
assert(trackFromWord("사회생활") === null && trackFromWord("") === null && trackFromWord("이거 재밌음") === null, "다른 말은 null");
assert(isBareTrackWord(" 사회. ") && !isBareTrackWord("사회 이슈 링크입니다"), "단독 단어 판정");
console.log("✅ 트랙 단어 인식");

// 2) 캡션 앞/뒤 토큰만 떼어 낸다
assert(JSON.stringify(splitTrackWord("사회")) === JSON.stringify({ track: "social", caption: "" }), "단어만");
assert(JSON.stringify(splitTrackWord("엔터 이거 재밌음")) === JSON.stringify({ track: "entertainment", caption: "이거 재밌음" }), "앞 토큰");
assert(JSON.stringify(splitTrackWord("이거 재밌음 사회")) === JSON.stringify({ track: "social", caption: "이거 재밌음" }), "뒤 토큰");
assert(JSON.stringify(splitTrackWord("요즘 사회 분위기")) === JSON.stringify({ track: null, caption: "요즘 사회 분위기" }), "가운데 단어는 캡션 본문");
assert(JSON.stringify(splitTrackWord("")) === JSON.stringify({ track: null, caption: "" }), "빈 캡션");
console.log("✅ 캡션에서 트랙 단어 분리");

// 3) 접수 답장 문구
assert(ackMessage("social").includes("사회") && ackMessage(null).includes("엔터") && ackMessage(null).includes("사회"), "접수 문구");
console.log("✅ 접수 문구");

// 4) 답 붙이기
const a = entry("A");
const b = entry("B", { askedTrackMessageId: 77 });
assert(resolveTrackReply([a], { text: "주제는 이겁니다", replyToMessageId: 5 }).status === "not_track", "트랙 단어가 아니면 not_track(주제 답장으로)");
assert(resolveTrackReply([], { text: "사회", replyToMessageId: null }).status === "nothing_waiting", "기다리는 링크 없음");
const single = resolveTrackReply([a], { text: "사회", replyToMessageId: null });
assert(single.status === "applied" && single.entryId === "A" && single.track === "social", "하나뿐이면 그 링크(단어만 보내도)");
const exact = resolveTrackReply([a, b], { text: "엔터", replyToMessageId: 77 });
assert(exact.status === "applied" && exact.entryId === "B" && exact.track === "entertainment", "맥이 물은 메시지에 답장하면 그 링크");
const amb = resolveTrackReply([a, b], { text: "엔터", replyToMessageId: null });
assert(amb.status === "ambiguous" && amb.candidates.length === 2, "여럿인데 대상 불명이면 ambiguous(다시 묻는다)");
console.log("✅ 답 붙이기 - 단일/답장 대상/모호");

console.log("\n✅ testInstagramTrack 전체 통과");
