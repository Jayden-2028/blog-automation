// 인스타 웹훅 핸들러 테스트. DB·텔레그램을 주입해 수신함 행 모양과 답장(버튼)만 본다. 실행: npm run test:ig-webhook
import { buildTrackCallbackData, handleInstagramUpdate, parseTrackCallbackData } from "./instagramWebhookHandler.js";
import type { InstagramWebhookDeps } from "./instagramWebhookHandler.js";
import { parseTrackPick } from "./instagramTrack.js";
import type { InstagramInboxRow } from "../../services/supabase/repositories/instagramInboxRepository.js";
import type { TelegramReplyMarkup } from "../../notifications/TelegramNotifier.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function harness(allowedChatId: string | null = "99") {
  const rows: InstagramInboxRow[] = [];
  const sent: { chatId: string; text: string; markup?: TelegramReplyMarkup }[] = [];
  const edited: { messageId: number; markup: TelegramReplyMarkup }[] = [];
  const deps: InstagramWebhookDeps = {
    allowedChatId,
    insertInbox: async (row) => { rows.push(row); },
    sendMessage: async (chatId, text, markup) => { sent.push({ chatId, text, markup }); },
    editReplyMarkup: async (_chat, messageId, markup) => { edited.push({ messageId, markup }); },
    now: () => new Date("2026-10-06T00:00:00Z"),
  };
  return { rows, sent, edited, deps };
}

async function main(): Promise<void> {
  // 1) 링크만 → 수신함 link + 버튼 2개(엔터/사회)
  {
    const h = harness();
    const out = await handleInstagramUpdate({ update_id: 10, message: { message_id: 5, chat: { id: 99 }, text: "https://www.instagram.com/p/ABC/ 이거" } }, h.deps);
    assert(out.handled === "link" && out.queueId === "tg-10" && out.track === null, `링크 접수 (${JSON.stringify(out)})`);
    assert(h.rows[0].kind === "link" && h.rows[0].id === "tg-10" && h.rows[0].instagramUrl === "https://www.instagram.com/p/ABC/" && h.rows[0].rawCaption === "이거", "수신함 link 행");
    const buttons = h.sent[0].markup?.inline_keyboard[0] ?? [];
    assert(buttons.length === 2 && buttons[0].callback_data === "igtrack:tg-10:entertainment" && buttons[1].callback_data === "igtrack:tg-10:social", `트랙 버튼 (${JSON.stringify(buttons)})`);
    console.log("✅ 링크 → 수신함 + 엔터/사회 버튼");
  }

  // 2) 링크 + "사회" → 버튼 없이 트랙 확정 답장, 캡션은 그대로(맥이 떼어 낸다)
  {
    const h = harness();
    const out = await handleInstagramUpdate({ update_id: 11, message: { message_id: 6, chat: { id: 99 }, text: "사회 https://www.instagram.com/p/DEF/" } }, h.deps);
    assert(out.handled === "link" && out.track === "social", "단어로 트랙 확정");
    assert(h.rows[0].rawCaption === "사회" && !h.sent[0].markup && h.sent[0].text.includes("사회"), "캡션 보존, 버튼 없음, 트랙 안내");
    console.log("✅ 링크 + 단어 → 바로 확정");
  }

  // 3) 버튼 선택 → topic_reply에 track:<큐id>:<트랙>, 버튼을 ✅로 교체
  {
    const h = harness();
    const out = await handleInstagramUpdate({ update_id: 12, callback_query: { id: "cb", data: buildTrackCallbackData("tg-10", "social"), message: { message_id: 7, chat: { id: 99 } } } }, h.deps);
    assert(out.handled === "track_pick" && out.queueId === "tg-10" && out.track === "social", "버튼 선택");
    assert(h.rows[0].kind === "topic_reply" && h.rows[0].replyToMessageId === null, "topic_reply 행");
    const pick = parseTrackPick(h.rows[0].replyText);
    assert(pick?.queueId === "tg-10" && pick.track === "social", `맥이 풀 수 있는 형식 (${h.rows[0].replyText})`);
    assert(h.edited[0]?.messageId === 7 && h.edited[0].markup.inline_keyboard[0][0].text.includes("사회") && h.edited[0].markup.inline_keyboard[0][0].callback_data === "noop", "버튼을 ✅ 선택됨(noop)으로 교체");
    console.log("✅ 버튼 선택 → 수신함 + ✅ 표시");
  }

  // 4) 답장·단어·잡담
  {
    const h = harness();
    const reply = await handleInstagramUpdate({ update_id: 13, message: { message_id: 8, chat: { id: 99 }, text: "주제는 이것", reply_to_message: { message_id: 3 } } }, h.deps);
    assert(reply.handled === "reply" && h.rows[0].kind === "topic_reply" && h.rows[0].replyToMessageId === 3 && h.rows[0].replyText === "주제는 이것", "주제 답장은 그대로 수신함");
    const bare = await handleInstagramUpdate({ update_id: 14, message: { message_id: 9, chat: { id: 99 }, text: "엔터" } }, h.deps);
    assert(bare.handled === "reply" && h.rows[1].replyToMessageId === null && h.rows[1].replyText === "엔터", "단어만 보내도 수신함");
    const chat = await handleInstagramUpdate({ update_id: 15, message: { message_id: 10, chat: { id: 99 }, text: "안녕" } }, h.deps);
    assert(chat.handled === "ignored" && h.rows.length === 2, "잡담은 무시");
    const other = await handleInstagramUpdate({ update_id: 16, message: { message_id: 11, chat: { id: 1 }, text: "https://www.instagram.com/p/X/" } }, h.deps);
    assert(other.handled === "ignored" && other.reason === "wrong_chat" && h.rows.length === 2, "다른 chat은 거부");
    const bad = await handleInstagramUpdate({ update_id: 17, callback_query: { id: "cb", data: "igtrack:nope:social", message: { message_id: 1, chat: { id: 99 } } } }, h.deps);
    assert(bad.handled === "ignored" && bad.reason === "bad_callback", "깨진 콜백은 무시");
    console.log("✅ 답장/단어/잡담/다른 chat/깨진 콜백");
  }

  assert(parseTrackCallbackData("igtrack:tg-1:entertainment")?.track === "entertainment" && parseTrackCallbackData("publish:x:y") === null, "콜백 파서");
  console.log("\n✅ testInstagramWebhookHandler 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
