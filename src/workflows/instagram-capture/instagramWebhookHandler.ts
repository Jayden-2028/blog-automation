// 인스타 변환기 봇의 **웹훅** 수신 처리(2026-10-06). 5분 주기 getUpdates 폴링(instagram-inbox-poll.yml)을 대체한다.
//
//   텔레그램 --webhook--> Worker(/webhook/instagram, 버튼 즉시 잠금·토스트) --repository_dispatch--> telegram-update.yml
//     --> runTelegramUpdateCli(track=instagram) --> 이 파일 --> Supabase 수신함(instagram_capture_inbox) --> 맥 폴러
//
// 왜 바꿨나(사용자 요청): 링크를 보낸 뒤 **버튼**으로 엔터/사회를 고르고 싶다. 폴링이면 버튼을 눌러도 최대 5분간
// 반응이 없다. 웹훅이면 Worker가 즉시 "⏳ 처리 중"으로 잠그고, 1분 안에 이 코드가 "✅ 선택됨"으로 바꾼다.
//
// 수신함 모양은 바꾸지 않는다(migration 없음). 버튼 선택은 topic_reply 행에 `track:<큐id>:<트랙>`로 적고 맥 폴러가
// 풀어 읽는다(instagramTrack.ts의 parseTrackPick). 글자로 고르는 길("사회 https://..." / 답장)도 그대로 된다.
//
// 이 파일은 DB 쓰기·텔레그램 발송을 전부 주입받는다 - 테스트는 네트워크 없이 돈다.

import { splitInstagramUrlAndCaption } from "../../notifications/InstagramCaptureBot.js";
import type { InstagramInboxRow } from "../../services/supabase/repositories/instagramInboxRepository.js";
import type { TelegramReplyMarkup } from "../../notifications/TelegramNotifier.js";
import { ackMessage, encodeTrackPick, isBareTrackWord, splitTrackWord, TRACK_LABEL } from "./instagramTrack.js";
import type { InstagramTrack } from "./instagramTrack.js";

/** 버튼 callback_data. `igtrack:<큐 id>:<트랙>`. 큐 id는 `tg-<update_id>`(수신함 행 id와 같다). */
export const TRACK_CALLBACK_PREFIX = "igtrack";
const QUEUE_ID_RE = /^tg-\d+$/;

export function buildTrackCallbackData(queueId: string, track: InstagramTrack): string {
  return `${TRACK_CALLBACK_PREFIX}:${queueId}:${track}`;
}

export function parseTrackCallbackData(data: string | undefined | null): { queueId: string; track: InstagramTrack } | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== TRACK_CALLBACK_PREFIX) return null;
  if (!QUEUE_ID_RE.test(parts[1])) return null;
  if (parts[2] !== "entertainment" && parts[2] !== "social") return null;
  return { queueId: parts[1], track: parts[2] };
}

export function trackButtons(queueId: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: TRACK_LABEL.entertainment, callback_data: buildTrackCallbackData(queueId, "entertainment") },
        { text: TRACK_LABEL.social, callback_data: buildTrackCallbackData(queueId, "social") },
      ],
    ],
  };
}

export type InstagramWebhookUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    caption?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number | string } };
  };
};

export type InstagramWebhookDeps = {
  /** 이 chat에서 온 것만 받는다(INSTAGRAM_BOT_CHAT_ID). 없으면 전부. */
  allowedChatId: string | null;
  insertInbox: (row: InstagramInboxRow) => Promise<unknown>;
  sendMessage: (chatId: string, text: string, replyMarkup?: TelegramReplyMarkup) => Promise<unknown>;
  editReplyMarkup: (chatId: string, messageId: number, replyMarkup: TelegramReplyMarkup) => Promise<unknown>;
  now?: () => Date;
};

export type InstagramWebhookOutcome =
  | { handled: "link"; queueId: string; track: InstagramTrack | null }
  | { handled: "track_pick"; queueId: string; track: InstagramTrack }
  | { handled: "reply"; replyToMessageId: number | null }
  | { handled: "ignored"; reason: "wrong_chat" | "empty" | "not_relevant" | "bad_callback" };

export async function handleInstagramUpdate(update: InstagramWebhookUpdate, deps: InstagramWebhookDeps): Promise<InstagramWebhookOutcome> {
  const now = deps.now ?? (() => new Date());
  const rowId = `tg-${update.update_id}`;

  // ---- 버튼: 트랙 선택 ----
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message ? String(cb.message.chat.id) : null;
    if (!chatId || (deps.allowedChatId && chatId !== deps.allowedChatId)) return { handled: "ignored", reason: "wrong_chat" };
    const parsed = parseTrackCallbackData(cb.data);
    if (!parsed) return { handled: "ignored", reason: "bad_callback" };

    await deps.insertInbox({
      id: rowId,
      kind: "topic_reply",
      instagramUrl: null,
      rawCaption: "",
      telegramChatId: chatId,
      telegramMessageId: cb.message!.message_id,
      replyToMessageId: null,
      replyText: encodeTrackPick(parsed.queueId, parsed.track),
      receivedAt: now().toISOString(),
    });
    // Worker가 "⏳ 처리 중"으로 잠근 버튼을 결과로 바꾼다. 다시 눌러도 noop(Worker가 거른다).
    await deps
      .editReplyMarkup(chatId, cb.message!.message_id, {
        inline_keyboard: [[{ text: `✅ ${TRACK_LABEL[parsed.track]} 선택됨`, callback_data: "noop" }]],
      })
      .catch(() => {});
    return { handled: "track_pick", queueId: parsed.queueId, track: parsed.track };
  }

  // ---- 메시지 ----
  const message = update.message;
  if (!message) return { handled: "ignored", reason: "empty" };
  const chatId = String(message.chat.id);
  if (deps.allowedChatId && chatId !== deps.allowedChatId) return { handled: "ignored", reason: "wrong_chat" };
  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) return { handled: "ignored", reason: "empty" };

  const parsed = splitInstagramUrlAndCaption(text);
  if (parsed) {
    // 캡션은 그대로 저장한다(트랙 단어 포함) - 떼어 내는 건 맥 폴러가 한다(폴링 시절과 같은 모양).
    const { track } = splitTrackWord(parsed.caption);
    await deps.insertInbox({
      id: rowId,
      kind: "link",
      instagramUrl: parsed.url,
      rawCaption: parsed.caption,
      telegramChatId: chatId,
      telegramMessageId: message.message_id,
      replyToMessageId: null,
      replyText: null,
      receivedAt: now().toISOString(),
    });
    if (track) {
      await deps.sendMessage(chatId, ackMessage(track)).catch(() => {});
    } else {
      await deps.sendMessage(chatId, "링크 접수했습니다. 어느 트랙으로 쓸까요?", trackButtons(rowId)).catch(() => {});
    }
    return { handled: "link", queueId: rowId, track };
  }

  // URL 없는 글자: 주제 답장(맥이 물은 것에 대한 답) 또는 "엔터"/"사회" 단어. 어느 항목인지는 맥만 안다.
  const replyToMessageId = message.reply_to_message?.message_id ?? null;
  if (replyToMessageId === null && !isBareTrackWord(text)) return { handled: "ignored", reason: "not_relevant" };
  await deps.insertInbox({
    id: rowId,
    kind: "topic_reply",
    instagramUrl: null,
    rawCaption: "",
    telegramChatId: chatId,
    telegramMessageId: message.message_id,
    replyToMessageId,
    replyText: text,
    receivedAt: now().toISOString(),
  });
  return { handled: "reply", replyToMessageId };
}
