// 인스타 링크의 **트랙 선택**(2026-10-06 사용자 요청): 같은 링크라도 엔터 기사일 수도, 사회 이슈일 수도 있다.
// 사용자가 링크를 보낼 때 "엔터"/"사회"를 고르면 그 트랙으로 원고가 흐른다 - 엔터면 메인봇 알림 + 네이버 뷰어·
// 네이버 발행, 사회면 사회 봇 알림 + 티스토리 뷰어·티스토리 발행(job.metadata.track, telegramTracks.ts).
//
// 고르는 방법 셋(2026-10-06부터 수신이 웹훅이라 버튼이 즉시 반응한다 - instagramWebhookHandler.ts):
//   1) 링크와 **같은 메시지**에 단어를 붙인다: "사회 https://instagram.com/p/..." → 바로 그 트랙(빠른 길).
//   2) 단어가 없으면 봇이 **🎬 엔터 / 🏛 사회 버튼**을 붙여 묻고 사용자가 누른다(`track:<큐id>:<트랙>`으로 수신함에 적힌다).
//      이미 처리된 링크의 남은 버튼은 맥 큐가 거른다(applyTrackPick - needs_track일 때만 적용).
//   3) 버튼 대신 "엔터" 또는 "사회"라고 **답장**(또는 그냥 그 단어만 전송)해도 된다.
//      답은 클라우드 → 수신함(topic_reply) → 맥 큐에 붙는다(needs_topic과 같은 길).
// 트랙이 정해질 때까지 캡처하지 않는다(needs_track). 캡처는 트랙과 무관하지만, 잡을 만들 때 트랙이 있어야
// 이후 알림·뷰어·발행이 갈라지므로 먼저 받는다.
//
// 순수 모듈 - 파일·네트워크 없음. 봇(클라우드)과 폴러(맥) 양쪽이 쓴다.

import type { InstagramQueueEntry } from "./types.js";

export type InstagramTrack = "entertainment" | "social";

/** 단어 → 트랙. 사용자가 실제로 쓸 법한 말을 넓게 받는다(네이버/티스토리는 채널 이름으로 트랙을 뜻한다). */
const TRACK_WORDS: ReadonlyArray<[RegExp, InstagramTrack]> = [
  [/^(엔터|연예|엔터테인먼트|네이버|ent|entertainment)$/i, "entertainment"],
  [/^(사회|시사|사회이슈|사회\s?이슈|티스토리|social)$/i, "social"],
];

export function trackFromWord(word: string): InstagramTrack | null {
  const w = word.trim().replace(/[.,!?:：]+$/, "");
  for (const [re, track] of TRACK_WORDS) if (re.test(w)) return track;
  return null;
}

/** 메시지 전체가 트랙 단어 하나인가("엔터", "사회 "). 답장·단독 전송 판정에 쓴다. */
export function isBareTrackWord(text: string): boolean {
  return trackFromWord(text) !== null;
}

/**
 * 캡션(링크를 뺀 나머지 글자)의 **맨 앞 또는 맨 뒤** 토큰이 트랙 단어면 떼어 낸다.
 * 가운데 섞인 단어는 건드리지 않는다 - "사회생활" 같은 캡션 본문을 트랙으로 오해하면 안 된다.
 */
export function splitTrackWord(rawCaption: string): { track: InstagramTrack | null; caption: string } {
  const tokens = rawCaption.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { track: null, caption: "" };
  const first = trackFromWord(tokens[0]);
  if (first) return { track: first, caption: tokens.slice(1).join(" ") };
  const last = trackFromWord(tokens[tokens.length - 1]);
  if (last) return { track: last, caption: tokens.slice(0, -1).join(" ") };
  return { track: null, caption: tokens.join(" ") };
}

export const TRACK_LABEL: Readonly<Record<InstagramTrack, string>> = { entertainment: "🎬 엔터", social: "🏛 사회" };

/** 클라우드 접수 답장. 트랙이 정해졌으면 그 사실을, 아니면 어떻게 고르는지를 한 줄로. */
export function ackMessage(track: InstagramTrack | null): string {
  if (track) return `링크 접수했습니다 → ${TRACK_LABEL[track]} 트랙. 원고 초안이 준비되면 알려드립니다.`;
  return [
    "링크 접수했습니다. 어느 트랙으로 쓸까요?",
    "이 메시지에 **엔터** 또는 **사회**라고 답장해 주세요 (그냥 그 단어만 보내도 됩니다).",
    "· 엔터 → 네이버 원고·네이버 뷰어   · 사회 → 티스토리 원고·티스토리 뷰어",
  ].join("\n");
}

/** 맥 폴러가 답을 못 붙여 다시 물을 때(기다리는 링크가 여럿이라 어느 것인지 모를 때). */
export function trackQuestion(entry: Pick<InstagramQueueEntry, "instagramUrl">): string {
  return ["📌 이 링크는 어느 트랙으로 쓸까요? 이 메시지에 엔터 또는 사회로 답장해 주세요.", "", entry.instagramUrl].join("\n");
}

/** 버튼 선택을 수신함 topic_reply 행의 reply_text에 담는 형식. 수신함 모양을 안 바꾸려고 글자로 싣는다. */
const TRACK_PICK_PREFIX = "track:";

export function encodeTrackPick(queueId: string, track: InstagramTrack): string {
  return `${TRACK_PICK_PREFIX}${queueId}:${track}`;
}

export function parseTrackPick(text: string | null | undefined): { queueId: string; track: InstagramTrack } | null {
  if (!text || !text.startsWith(TRACK_PICK_PREFIX)) return null;
  const [queueId, track] = text.slice(TRACK_PICK_PREFIX.length).split(":");
  if (!queueId || (track !== "entertainment" && track !== "social")) return null;
  return { queueId, track };
}

export type TrackReplyInput = {
  text: string;
  /** 답장이면 원 메시지 id, 그냥 보낸 단어면 null. */
  replyToMessageId: number | null;
};

export type TrackReplyOutcome =
  | { status: "applied"; entryId: string; track: InstagramTrack }
  /** 트랙 단어가 아니다 - 이 답은 트랙용이 아니다(주제 답장 등 다른 처리로 넘긴다). */
  | { status: "not_track" }
  /** 트랙 단어지만 어느 링크인지 못 정했다(기다리는 링크가 여럿·답장 대상 불명). 호출자가 링크별로 다시 묻는다. */
  | { status: "ambiguous"; candidates: InstagramQueueEntry[] }
  /** 기다리는 링크가 없다. */
  | { status: "nothing_waiting" };

/**
 * 트랙 답을 어느 링크에 붙일지 정한다. 순수 함수.
 *  1) 답장 대상이 맥이 물은 메시지(askedTrackMessageId)면 그 링크.
 *  2) 기다리는 링크가 하나뿐이면 그것(클라우드 접수 답장에 답했거나 그냥 단어만 보낸 경우).
 *  3) 여럿이면 ambiguous - 엉뚱한 링크에 붙이는 것보다 다시 묻는 게 낫다.
 */
export function resolveTrackReply(awaiting: readonly InstagramQueueEntry[], input: TrackReplyInput): TrackReplyOutcome {
  const track = trackFromWord(input.text);
  if (!track) return { status: "not_track" };
  if (awaiting.length === 0) return { status: "nothing_waiting" };
  if (input.replyToMessageId !== null) {
    const exact = awaiting.find((e) => e.askedTrackMessageId === input.replyToMessageId);
    if (exact) return { status: "applied", entryId: exact.id, track };
  }
  if (awaiting.length === 1) return { status: "applied", entryId: awaiting[0].id, track };
  return { status: "ambiguous", candidates: [...awaiting] };
}
