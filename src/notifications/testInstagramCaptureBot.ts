// InstagramCaptureBot 테스트. 실제 Telegram API/DB/파일을 호출하지 않는다 - 모든 의존성은
// 생성자 옵션으로 주입한다(testTelegramBot.ts와 같은 방식).
//
// 지켜야 할 성질:
// 1. instagram.com/p 또는 /reel URL이 있는 메시지만 큐에 넣는다
// 2. URL을 뺀 나머지 텍스트를 캡션으로 넘긴다
// 3. allowedChatId가 있으면 다른 chat은 무시한다(큐에 안 넣고 offset만 전진)
// 4. URL이 없는 메시지는 무시한다
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
    sendMessage: async () => {},
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
    sendMessage: async () => {},
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
    sendMessage: async () => {},
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

async function main(): Promise<void> {
  console.log("▶ InstagramCaptureBot 테스트 시작\n");
  await testEnqueuesUrlWithCaption();
  await testIgnoresMessageWithoutUrl();
  await testRejectsOtherChat();
  await testAdvancesOffsetForEveryUpdate();
  console.log("\n✅ InstagramCaptureBot 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
