// InstagramCaptureBot 테스트. 실제 Telegram API/DB/파일을 호출하지 않는다 - 모든 의존성은
// 생성자 옵션으로 주입한다(testTelegramBot.ts와 같은 방식).
//
// 지켜야 할 성질:
// 1. instagram.com/p 또는 /reel URL이 있는 메시지만 큐에 넣는다
// 2. URL을 뺀 나머지 텍스트를 캡션으로 넘긴다
// 3. allowedChatId가 있으면 다른 chat은 무시한다(큐에 안 넣고 offset만 전진)
// 4. URL이 없는 메시지는 무시한다 - 단, 주제를 물어본 항목이 있으면 그 답으로 받는다(2026-09-23)
// 5. 처리한 update는 성공/무시 여부와 무관하게 offset을 전진시킨다(재처리 방지)

import { InstagramCaptureBot } from "./InstagramCaptureBot.js";
import type { InstagramQueueEntry } from "../workflows/instagram-capture/types.js";
import type { TelegramUpdateLike } from "./InstagramCaptureBot.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeUpdate(updateId: number, chatId: string, text: string): TelegramUpdateLike {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: chatId }, text } };
}

async function testEnqueuesUrlWithCaption(): Promise<void> {
  const enqueued: InstagramQueueEntry[] = [];
  const advanced: number[] = [];

  const bot = new InstagramCaptureBot({
    botToken: "test-token",
    fetchUpdates: async () => [
      makeUpdate(1, "111", "이거 재밌음 https://www.instagram.com/p/ABC123/ 캐러셀 3장짜리"),
    ],
    sendMessage: async () => 1,
    getStoredOffset: async () => null,
    advanceStoredOffset: async (id) => {
      advanced.push(id);
    },
    enqueue: async (entry) => {
      enqueued.push(entry);
    },
  });

  const result = await bot.pollOnce();

  assert(result.processed === 1, "processed는 1이어야 한다");
  assert(result.enqueued === 1, "enqueued는 1이어야 한다");
  assert(enqueued.length === 1, "큐에 정확히 1건 적재");
  assert(enqueued[0].instagramUrl === "https://www.instagram.com/p/ABC123/", `URL이 그대로 보존돼야 한다: ${enqueued[0].instagramUrl}`);
  assert(
    enqueued[0].rawCaption === "이거 재밌음  캐러셀 3장짜리".replace(/\s+/g, " ").trim() ||
      enqueued[0].rawCaption.includes("캐러셀 3장짜리"),
    `캡션에 URL 제외 텍스트가 남아야 한다: "${enqueued[0].rawCaption}"`
  );
  assert(advanced.includes(1), "offset이 전진해야 한다");
  console.log("✅ URL+캡션 메시지 -> 큐 적재, 나머지 텍스트가 캡션으로 보존됨");
}

async function testIgnoresMessageWithoutUrl(): Promise<void> {
  let enqueuedCount = 0;
  const bot = new InstagramCaptureBot({
    botToken: "test-token",
    fetchUpdates: async () => [makeUpdate(2, "111", "안녕하세요 그냥 인사입니다")],
    sendMessage: async () => 1,
    getStoredOffset: async () => 1,
    advanceStoredOffset: async () => {},
    enqueue: async () => {
      enqueuedCount += 1;
    },
  });

  const result = await bot.pollOnce();
  assert(result.enqueued === 0, "URL 없는 메시지는 큐에 안 들어가야 한다");
  assert(result.ignored === 1, "무시 카운트가 1이어야 한다");
  assert(enqueuedCount === 0, "enqueue가 호출되지 않아야 한다");
  console.log("✅ URL 없는 메시지는 무시된다");
}

async function testRejectsOtherChat(): Promise<void> {
  let enqueuedCount = 0;
  const bot = new InstagramCaptureBot({
    botToken: "test-token",
    allowedChatId: "999",
    fetchUpdates: async () => [makeUpdate(3, "111", "https://www.instagram.com/p/XYZ/")],
    sendMessage: async () => {
      throw new Error("허용 안 된 chat에는 응답을 보내면 안 된다");
    },
    getStoredOffset: async () => 2,
    advanceStoredOffset: async () => {},
    enqueue: async () => {
      enqueuedCount += 1;
    },
  });

  const result = await bot.pollOnce();
  assert(result.enqueued === 0, "허용되지 않은 chat의 메시지는 큐에 안 들어가야 한다");
  assert(enqueuedCount === 0, "enqueue가 호출되지 않아야 한다");
  console.log("✅ allowedChatId와 다른 chat의 메시지는 거부된다");
}

async function testAdvancesOffsetForEveryUpdate(): Promise<void> {
  const advanced: number[] = [];
  const bot = new InstagramCaptureBot({
    botToken: "test-token",
    fetchUpdates: async () => [
      makeUpdate(10, "111", "그냥 텍스트"),
      makeUpdate(11, "111", "https://www.instagram.com/reel/QQQ/"),
    ],
    sendMessage: async () => 1,
    getStoredOffset: async () => 9,
    advanceStoredOffset: async (id) => {
      advanced.push(id);
    },
    enqueue: async () => {},
  });

  await bot.pollOnce();
  assert(advanced.length === 2 && advanced[0] === 10 && advanced[1] === 11, `무시된 update도 offset이 전진해야 한다: ${advanced}`);
  console.log("✅ 처리 결과와 무관하게 모든 update의 offset이 전진한다(재처리 방지)");
}


/** 주제를 기다리는 가짜 항목. 실제 큐 파일은 건드리지 않는다. */
function waitingEntry(id: string, askedMessageId: number): InstagramQueueEntry {
  return {
    id,
    instagramUrl: `https://www.instagram.com/p/${id}/`,
    rawCaption: "",
    telegramChatId: "111",
    telegramMessageId: 1,
    receivedAt: "2026-09-23T00:00:00Z",
    status: "needs_topic",
    askedMessageId,
  };
}

function replyUpdate(updateId: number, text: string, replyTo?: number): TelegramUpdateLike {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: "111" },
      text,
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
    },
  };
}

async function testTopicReplyByReplyTo(): Promise<void> {
  const applied: Array<[string, string]> = [];
  const bot = new InstagramCaptureBot({
    botToken: "t",
    fetchUpdates: async () => [replyUpdate(20, "이나영 신작 출연 소식", 777)],
    sendMessage: async () => 1,
    getStoredOffset: async () => null,
    advanceStoredOffset: async () => {},
    enqueue: async () => {},
    listAwaitingTopic: () => [waitingEntry("a", 777), waitingEntry("b", 888)],
    applyTopic: (id, topic) => applied.push([id, topic]),
  });

  const result = await bot.pollOnce();
  assert(result.topicsAnswered === 1, "답장 1건이 처리돼야 한다");
  assert(applied.length === 1 && applied[0][0] === "a", `답장한 메시지의 항목에 붙어야 한다: ${JSON.stringify(applied)}`);
  assert(applied[0][1] === "이나영 신작 출연 소식", "본문이 주제로 들어가야 한다");
  console.log("✅ 답장(reply_to)은 물어본 메시지의 항목에 정확히 붙는다");
}

async function testTopicReplyWithoutReplyTo(): Promise<void> {
  // 모바일에서 답장 기능을 안 쓰고 그냥 타이핑하는 경우. 기다리는 항목이 하나뿐이면 받아준다.
  const applied: Array<[string, string]> = [];
  const bot = new InstagramCaptureBot({
    botToken: "t",
    fetchUpdates: async () => [replyUpdate(21, "심은하 M 리부트")],
    sendMessage: async () => 1,
    getStoredOffset: async () => null,
    advanceStoredOffset: async () => {},
    enqueue: async () => {},
    listAwaitingTopic: () => [waitingEntry("only", 777)],
    applyTopic: (id, topic) => applied.push([id, topic]),
  });

  const result = await bot.pollOnce();
  assert(result.topicsAnswered === 1, "하나뿐이면 답장이 아니어도 받는다");
  assert(applied[0][0] === "only", "그 항목에 붙어야 한다");
  console.log("✅ 답장이 아니어도 기다리는 항목이 하나면 받아준다");
}

async function testAmbiguousTopicReplyIgnored(): Promise<void> {
  // 둘 이상 기다리는데 답장도 아니면 어느 것인지 알 수 없다. 엉뚱한 게시물에 붙이는 것보다
  // 무시하는 편이 낫다.
  const applied: string[] = [];
  const bot = new InstagramCaptureBot({
    botToken: "t",
    fetchUpdates: async () => [replyUpdate(22, "무슨 주제")],
    sendMessage: async () => 1,
    getStoredOffset: async () => null,
    advanceStoredOffset: async () => {},
    enqueue: async () => {},
    listAwaitingTopic: () => [waitingEntry("a", 777), waitingEntry("b", 888)],
    applyTopic: (id) => applied.push(id),
  });

  const result = await bot.pollOnce();
  assert(result.topicsAnswered === 0, "모호하면 받지 않는다");
  assert(result.ignored === 1, "무시로 집계돼야 한다");
  assert(applied.length === 0, "아무 항목에도 붙이면 안 된다");
  console.log("✅ 기다리는 항목이 여럿인데 답장이 아니면 받지 않는다");
}

async function testUrlStillWinsOverTopicReply(): Promise<void> {
  // 주제를 기다리는 중에도 새 링크는 정상 적재돼야 한다.
  const enqueued: InstagramQueueEntry[] = [];
  const applied: string[] = [];
  const bot = new InstagramCaptureBot({
    botToken: "t",
    fetchUpdates: async () => [replyUpdate(23, "https://www.instagram.com/p/NEW/")],
    sendMessage: async () => 1,
    getStoredOffset: async () => null,
    advanceStoredOffset: async () => {},
    enqueue: async (e) => {
      enqueued.push(e);
    },
    listAwaitingTopic: () => [waitingEntry("a", 777)],
    applyTopic: (id) => applied.push(id),
  });

  const result = await bot.pollOnce();
  assert(result.enqueued === 1, "링크는 링크로 처리한다");
  assert(applied.length === 0, "주제 답장으로 오인하면 안 된다");
  assert(enqueued[0].instagramUrl.includes("/p/NEW/"), "새 링크가 적재돼야 한다");
  console.log("✅ 주제를 기다리는 중에도 새 링크는 정상 적재된다");
}

async function main(): Promise<void> {
  console.log("▶ InstagramCaptureBot 테스트 시작\n");
  await testEnqueuesUrlWithCaption();
  await testIgnoresMessageWithoutUrl();
  await testRejectsOtherChat();
  await testAdvancesOffsetForEveryUpdate();
  await testTopicReplyByReplyTo();
  await testTopicReplyWithoutReplyTo();
  await testAmbiguousTopicReplyIgnored();
  await testUrlStillWinsOverTopicReply();
  console.log("\n✅ InstagramCaptureBot 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
