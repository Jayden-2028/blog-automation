// 인스타 링크 수신함(2026-09-25). 받는 일은 클라우드가, 캡처는 맥이 한다.
//
// 왜 갈랐나(실측): 맥이 네트워크 장애로 39시간 멈췄는데 텔레그램은 미확인 업데이트를 24시간만
// 보관한다. 그 경계를 넘기면 링크가 사라진다. 받는 일만 GitHub Actions로 옮기면 맥이 며칠을
// 자도 링크는 남고, 처리만 늦어진다.

import { supabase } from "../client.js";

const TABLE = "instagram_capture_inbox";

export type InstagramInboxRow = {
  id: string;
  /** `link`는 인스타 주소, `topic_reply`는 "주제가 뭔가요"에 대한 답장이다. */
  kind: "link" | "topic_reply";
  instagramUrl: string | null;
  rawCaption: string;
  telegramChatId: string;
  telegramMessageId: number;
  /** topic_reply만. 어느 질문에 대한 답인지 - 맥이 자기 큐에서 이 값으로 찾는다. */
  replyToMessageId: number | null;
  replyText: string | null;
  receivedAt: string;
};

/**
 * 새 링크를 넣는다. 같은 업데이트가 재전달돼도 **한 번만** 들어간다(id가 기본키).
 *
 * 이미 있는 행은 덮어쓰지 않는다 - 맥이 이미 가져갔다면 `claimed_at`을 지워버리면 두 번 처리된다.
 */
export async function insertInboxEntry(row: InstagramInboxRow): Promise<{ inserted: boolean }> {
  const { error } = await supabase.from(TABLE).insert({
    id: row.id,
    kind: row.kind,
    instagram_url: row.instagramUrl,
    raw_caption: row.rawCaption,
    telegram_chat_id: row.telegramChatId,
    telegram_message_id: row.telegramMessageId,
    reply_to_message_id: row.replyToMessageId,
    reply_text: row.replyText,
    received_at: row.receivedAt,
  });
  // 23505 = unique_violation. 재전달이라 오류가 아니다.
  if (error && error.code !== "23505") throw error;
  return { inserted: !error };
}

/** 맥이 아직 안 가져간 링크. 오래된 것부터 준다. */
export async function listUnclaimed(limit = 50): Promise<InstagramInboxRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(
      "id, kind, instagram_url, raw_caption, telegram_chat_id, telegram_message_id, reply_to_message_id, reply_text, received_at"
    )
    .is("claimed_at", null)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: (r.kind as "link" | "topic_reply") ?? "link",
    instagramUrl: (r.instagram_url as string | null) ?? null,
    rawCaption: (r.raw_caption as string) ?? "",
    telegramChatId: r.telegram_chat_id as string,
    telegramMessageId: Number(r.telegram_message_id),
    replyToMessageId: r.reply_to_message_id === null ? null : Number(r.reply_to_message_id),
    replyText: (r.reply_text as string | null) ?? null,
    receivedAt: r.received_at as string,
  }));
}

/**
 * 가져갔다고 표시한다. **지우지 않는다** - 언제 받아 언제 처리했는지가 감사 기록으로 남아야 한다.
 */
export async function markClaimed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from(TABLE)
    .update({ claimed_at: new Date().toISOString() })
    .in("id", [...ids]);
  if (error) throw error;
}
