// 인스타 링크 **수신**만 한다(2026-09-25). GitHub Actions에서 돈다.
//
// 왜 갈랐나(실측): 링크를 받는 폴러가 맥에서만 돌았는데, 맥이 네트워크 장애·절전으로 39시간
// 멈췄다. 텔레그램은 미확인 업데이트를 **24시간만** 보관하므로 그 경계를 넘기면 링크가 사라진다.
//
// 받는 일에는 브라우저가 필요 없다 - 클라우드에서 돌 수 있다. 캡처만 맥에 남긴다(인스타 로그인
// 세션을 CI에 두면 계정 탈취급 위험이고, 데이터센터 IP는 인스타가 먼저 막는다).
//
//   텔레그램 --(이 job, GitHub Actions cron)--> instagram_capture_inbox --> 맥 폴러 --> 캡처
//
// **텔레그램을 소비하는 곳은 여기 하나다.** 맥 폴러는 더 이상 getUpdates를 부르지 않는다 -
// 둘이 같이 부르면 offset을 두고 서로 잡아먹는다.
import "dotenv/config";

import { InstagramCaptureBot } from "../notifications/InstagramCaptureBot.js";
import { insertInboxEntry } from "../services/supabase/repositories/instagramInboxRepository.js";

async function main(): Promise<void> {
  const bot = InstagramCaptureBot.fromEnv({
    // 로컬 JSONL 대신 Supabase에 쌓는다. 맥이 자고 있어도 여기 남는다.
    enqueue: async (entry) => {
      await insertInboxEntry({
        id: entry.id,
        kind: "link",
        replyToMessageId: null,
        replyText: null,
        instagramUrl: entry.instagramUrl,
        rawCaption: entry.rawCaption ?? "",
        telegramChatId: entry.telegramChatId,
        telegramMessageId: entry.telegramMessageId,
        receivedAt: entry.receivedAt,
      });
    },
    // 어느 항목에 대한 답인지는 **맥의 큐에만** 있다(askedMessageId를 맥이 붙인다).
    // 그래서 여기서는 판단하지 않고 그대로 수신함에 넣는다 - 안 넣으면 offset만 올라가고
    // 답장이 사라진다.
    listAwaitingTopic: () => [],
    onUnmatchedReply: async (reply) => {
      await insertInboxEntry({
        id: `tg-${reply.updateId}`,
        kind: "topic_reply",
        instagramUrl: null,
        rawCaption: "",
        telegramChatId: reply.chatId,
        telegramMessageId: reply.messageId,
        replyToMessageId: reply.replyToMessageId,
        replyText: reply.text,
        receivedAt: new Date().toISOString(),
      });
    },
  });

  const result = await bot.pollOnce();
  if (result.processed > 0) {
    console.log(`▶ [ig-inbox-poll] update ${result.processed}건 - 수신함 적재 ${result.enqueued}건 / 무시 ${result.ignored}건`);
  }
}

main().catch((error) => {
  console.error("❌ [ig-inbox-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
