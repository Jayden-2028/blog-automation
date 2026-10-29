// 인스타 링크 트랙 선택 테스트(instagramTrack.ts). 실행: npm run test:ig-track
import {
  ackMessage, categoryForTrack, isBareTrackWord, isConverterJobSource, isInstagramTrack, jobMetadataForTrack, parseTrackPick,
  resolveTrackReply, splitTrackWord, TRACK_LABEL, trackFromWord, trackQuestion,
} from "./instagramTrack.js";
import { trackJobMetadata, trackOfJob } from "../../notifications/telegramTracks.js";
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

// 5) 🌏 국제(2026-10-29) - 사용설명서(kscene) 재사용. 새 트랙·새 봇 없음.
for (const w of ["국제", "글로벌", "영문", "영어", "블로그스팟", "blogspot", "global", "GLOBAL", "kscene", " 국제. "]) {
  assert(trackFromWord(w) === "global", `국제 단어: ${w}`);
}
assert(trackFromWord("국제결혼") === null && trackFromWord("영어회화") === null && trackFromWord("국제 정세") === null, "합성어·구는 트랙 단어가 아니다");
assert(JSON.stringify(splitTrackWord("국제 https://www.instagram.com/p/X/ 캡션")) === JSON.stringify({ track: "global", caption: "https://www.instagram.com/p/X/ 캡션" }), "링크와 같은 메시지의 국제");
assert(JSON.stringify(splitTrackWord("남산 케이블카 타는 법 국제")) === JSON.stringify({ track: "global", caption: "남산 케이블카 타는 법" }), "뒤 토큰 국제");
assert(TRACK_LABEL.global === "🌏 국제" && isInstagramTrack("global") && !isInstagramTrack("kscene"), "라벨·트랙 판정(kscene은 내부 트랙 이름이 아니라 job 모양)");
assert(categoryForTrack("global") === "kscene", "국제 → category=kscene");
assert(JSON.stringify(jobMetadataForTrack("global")) === JSON.stringify({ track: "kscene" }), "국제 → metadata.track=kscene");
assert(JSON.stringify(jobMetadataForTrack("global")) === JSON.stringify(trackJobMetadata("kscene")), "kscene-topic Go 버튼(trackJobMetadata)과 같은 모양");
assert(trackOfJob({ metadata: jobMetadataForTrack("global") }) === "kscene", "알림·뷰어·발행 채널은 사용설명서 봇");
const pick = parseTrackPick("track:tg-9:global");
assert(pick?.queueId === "tg-9" && pick.track === "global", "버튼 선택 파싱");
assert(ackMessage("global").includes("🌏 국제") && ackMessage(null).includes("국제 → 블로그스팟 영문 원고·사용설명서 봇"), "접수 문구에 국제");
assert(trackQuestion(entry("Q")).includes("국제"), "다시 묻는 문구에 국제");
const g = resolveTrackReply([entry("G")], { text: "영문", replyToMessageId: null });
assert(g.status === "applied" && g.track === "global", "답장으로 국제 선택");
assert(isConverterJobSource({ source: "instagram_manual" }) && isConverterJobSource({ source: "keyword_input" }), "변환기 출처 판정");
assert(!isConverterJobSource({ source: "trend" }) && !isConverterJobSource({ track: "kscene" }) && !isConverterJobSource(null), "kscene-topic Go·트렌드 job은 변환기 출처가 아니다");
// 기존 5트랙 불변
assert(categoryForTrack("social") === null && categoryForTrack("entertainment") === null && JSON.stringify(jobMetadataForTrack("entertainment")) === "{}", "기존 트랙 category/metadata 불변");
console.log("✅ 🌏 국제 - 단어·라벨·category=kscene·metadata.track=kscene·변환기 출처 판정");

console.log("\n✅ testInstagramTrack 전체 통과");
