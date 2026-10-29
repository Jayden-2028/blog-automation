// 링크 자동 추출 입력(B부)의 수신함 전달 형식과 큐 항목 변환(순수). 클라우드가 링크를 읽어 수신함(kind=source)에 싣고, 맥이 풀어 큐에 세운다.
// 수신함 모양은 바꾸지 않는다: instagram_url=원본 링크, raw_caption=JSON(LinkSourcePayload).
import { splitTrackWord } from "./instagramTrack.js";
import type { InstagramTrack } from "./instagramTrack.js";
import { stripCommandTail } from "./directInput.js";
import type { ExtractResult } from "../input-extract/extractLinkSource.js";
import { classifyLink } from "../input-extract/linkClassify.js";
import type { InstagramQueueEntry } from "./types.js";

export type LinkSourcePayload = {
  url: string;
  title: string | null;
  text: string;
  /** 링크와 함께 보낸 말(트랙 단어를 뗀 나머지). 뉴스 검색어·유튜브 요점·주제로 쓴다. */
  note: string;
  via: string;
  /** 링크 메시지에 붙은 트랙 단어("테크 https://..."). 없으면 버튼으로 받는다. */
  track?: InstagramTrack;
};

export function encodeLinkSource(payload: LinkSourcePayload): string {
  return JSON.stringify(payload);
}

export function decodeLinkSource(raw: string): LinkSourcePayload | null {
  try {
    const v = JSON.parse(raw) as Partial<LinkSourcePayload>;
    if (typeof v.url !== "string" || typeof v.text !== "string") return null;
    return {
      url: v.url,
      title: typeof v.title === "string" ? v.title : null,
      text: v.text,
      note: typeof v.note === "string" ? v.note : "",
      via: typeof v.via === "string" ? v.via : "web",
      ...(v.track ? { track: v.track } : {}),
    };
  } catch {
    return null;
  }
}

export type LinkResolution = { ok: true; payload: LinkSourcePayload } | { ok: false; reply: string };

/**
 * 링크 메시지 하나를 소스 본문으로 푼다. 트랙 단어를 먼저 떼고(힌트가 뉴스 검색어가 되므로), 추출이 실패해도 유튜브처럼
 * 사용자가 요점을 같이 보냈다면 그 글을 소스로 쓴다(YOUTUBE_API_KEY 부재 시 비치명 경로).
 */
export async function resolveLinkSource(
  url: string,
  messageRest: string,
  extract: (url: string, hint: string) => Promise<ExtractResult>
): Promise<LinkResolution> {
  const { track, caption: note } = splitTrackWord(messageRest);
  const result = await extract(url, note);
  if (result.status === "ok") {
    return { ok: true, payload: { url, title: result.title, text: result.text, note, via: result.via, ...(track ? { track } : {}) } };
  }
  if (classifyLink(url).kind === "youtube" && note.replace(/\s+/g, "").length >= 10) {
    return { ok: true, payload: { url, title: null, text: note, note: "", via: "user_note", ...(track ? { track } : {}) } };
  }
  return { ok: false, reply: result.reply };
}

/** 페이로드 -> 큐 항목 조각. 주제를 정할 수 있으면 트랙 대기(또는 트랙이 있으면 바로 pending), 못 정하면 주제부터 묻는다. */
export function queueFieldsForLinkSource(payload: LinkSourcePayload): Pick<
  InstagramQueueEntry,
  "source" | "status" | "userTopic" | "sourceText" | "sourceUrl" | "track"
> {
  const isYoutube = payload.via === "youtube_meta";
  const noteTopic = payload.note && !isYoutube ? stripCommandTail(payload.note).slice(0, 120) : "";
  const topic = noteTopic || payload.title || "";
  // 메모가 주제로 쓰이지 않았으면(유튜브 요점·제목이 따로 있는 경우) 소스 본문에 함께 싣는다.
  const sourceText = payload.note && payload.note !== noteTopic ? `${payload.text}\n\n사용자 요점: ${payload.note}` : payload.text;
  return {
    source: "text",
    sourceText,
    sourceUrl: payload.url,
    ...(topic ? { userTopic: topic } : {}),
    ...(payload.track ? { track: payload.track } : {}),
    status: !topic ? "needs_topic" : payload.track ? "pending" : "needs_track",
  };
}

/** 클라우드 접수 답장. 읽은 결과를 보여준다. */
export function linkSourceAck(payload: LinkSourcePayload): string {
  const chars = payload.text.replace(/\s+/g, "").length;
  const label = payload.title ? `"${payload.title.length > 60 ? `${payload.title.slice(0, 60)}…` : payload.title}"` : "(제목 없음)";
  return `접수: ${label} — 본문 ${chars}자를 읽었습니다. 트랙을 답해주세요 (엔터/사회/일상/테크/인물/국제)`;
}
