// topicIntake.ts의 실제 입출력(DB 조회 + 텔레그램 호출). 테스트는 이 파일을 쓰지 않고 deps를 주입한다.
import { resolveTrackCredentials } from "../../notifications/telegramTracks.js";
import type { Track } from "../../notifications/telegramTracks.js";
import { sendTelegramWithRetry } from "../../notifications/telegramRetry.js";
import { supabase } from "../../services/supabase/client.js";
import { PICK_KEYBOARD } from "./topicIntake.js";
import type { TopicBot } from "./topicIntake.js";

/** 같은 봇·같은 원 메시지 번호로 이미 만든 job. 없으면 null. */
export async function findTopicJobByMessageId(bot: TopicBot, messageId: number): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("article_jobs")
    .select("id")
    .filter("metadata->>topicInputBot", "eq", bot)
    .filter("metadata->>topicInputMessageId", "eq", String(messageId))
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as { id?: unknown } | undefined;
  return row?.id ? { id: String(row.id) } : null;
}

async function call(track: Track, method: string, body: Record<string, unknown>): Promise<void> {
  const { botToken } = resolveTrackCredentials(track);
  const response = await sendTelegramWithRetry(method, () =>
    fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  if (!response.ok) throw new Error(`Telegram ${method} 실패: HTTP ${response.status}`);
}

/** 원 메시지에 답장으로 [엔터][인물] 질문을 보낸다(원문이 버튼 callback에 reply_to_message로 실린다). */
export async function sendTopicPrompt(track: Track, text: string, replyToMessageId: number | null): Promise<void> {
  const { chatId } = resolveTrackCredentials(track);
  await call(track, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyToMessageId !== null ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    reply_markup: PICK_KEYBOARD,
  });
}

/** 질문 메시지를 결과 문구로 바꾸고 버튼을 걷는다. */
export async function editTopicPrompt(track: Track, chatId: string, messageId: number, text: string): Promise<void> {
  await call(track, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  });
}
