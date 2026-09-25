// 인스타 포스팅 변환기 봇 폴링 진입점. telegramPollJob.ts와 같은 패턴(launchd가 짧게 반복 실행,
// offset은 telegram_offsets에 별도 receiverId로 보관, 동시 실행은 파일 락으로 막는다).
//
// 2026-09-22부터 적재에서 끝나지 않고 **캡처 -> job 생성 -> 자료조사 발화까지** 이어서 한다
// (INSTAGRAM_CAPTURE_AUTOMATION.md). 텔레그램 전송 이후 원고 초안이 도착할 때까지 사람 개입이
// 없어야 한다는 요구 때문이다. IG_CAPTURE_AUTO=true + IG_BROWSER_PROFILE이 있어야 돌고, 없으면
// 예전처럼 적재만 하고 끝난다(대기열은 npm run ig-capture:status로 확인, 수동 처리도 그대로 된다).
import "dotenv/config";

import { resolve } from "node:path";

import { InstagramCaptureBot } from "../notifications/InstagramCaptureBot.js";
import { listUnclaimed, markClaimed } from "../services/supabase/repositories/instagramInboxRepository.js";
import { appendQueueEntry, listAwaitingTopic, markEntry } from "../workflows/instagram-capture/instagramQueue.js";
import { TelegramNotifier, escapeTelegramHtml } from "../notifications/TelegramNotifier.js";
import { captureReadiness, processPendingCaptures } from "../workflows/instagram-capture/processPendingCaptures.js";
import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { describeRecovery, recordFailure, takeRecovery } from "./lib/outageTracker.js";

/** 멈춘 기록을 남기는 곳. 원격이 죽어 있을 때도 써야 하므로 **로컬 파일**이다. */
const OUTAGE_PATH = resolve("logs/.instagram-capture-poll-outage.json");

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.instagram-capture-poll.lock"));
  if (!lock) return;

  // 봇은 이제 **보내기 전용**이다(주제 질문). 받기는 클라우드가 한다.
  const bot = InstagramCaptureBot.fromEnv();

  // **텔레그램을 직접 받지 않는다**(2026-09-25). 받는 일은 GitHub Actions(`job:ig-inbox-poll`)가
  // 하고 Supabase 수신함에 쌓는다. 맥은 거기서 가져간다 - 맥이 며칠을 자도 링크가 남는다.
  // 둘이 같이 getUpdates를 부르면 offset을 두고 서로 잡아먹으므로 소비자는 하나여야 한다.
  //
  // 주제 답장(needs_topic)은 여전히 이 봇이 받는다 - 답장을 붙일 큐가 맥에 있기 때문이다.
  let result: Awaited<ReturnType<typeof bot.pollOnce>>;
  try {
    const inbox = await listUnclaimed();
    let links = 0;
    let topics = 0;
    for (const row of inbox) {
      if (row.kind === "topic_reply") {
        // 어느 항목에 대한 답인지는 **여기서만** 안다 - askedMessageId가 맥의 큐에 있다.
        const target = listAwaitingTopic().find((e) => e.askedMessageId === row.replyToMessageId);
        if (target && row.replyText) {
          markEntry(target.id, { status: "pending", userTopic: row.replyText });
          topics += 1;
        }
        continue;
      }
      if (!row.instagramUrl) continue;
      await appendQueueEntry({
        id: row.id,
        instagramUrl: row.instagramUrl,
        rawCaption: row.rawCaption,
        telegramChatId: row.telegramChatId,
        telegramMessageId: row.telegramMessageId,
        receivedAt: row.receivedAt,
        status: "pending",
        attempts: 0,
      });
      links += 1;
    }
    // 로컬 큐에 옮긴 뒤에 표시한다 - 순서가 반대면 옮기다 죽었을 때 링크를 잃는다.
    await markClaimed(inbox.map((row) => row.id));
    if (inbox.length > 0) {
      console.log(`▶ [ig-capture-poll] 수신함에서 ${inbox.length}건 가져왔습니다(링크 ${links} / 주제 답장 ${topics}).`);
    }

    // 소비자가 둘이면 offset을 두고 서로 잡아먹으므로 **한쪽만** 텔레그램을 부른다.
    //
    // `IG_INBOX_MODE=true`면 클라우드(`instagram-inbox-poll.yml`)가 받고 맥은 수신함만 본다.
    // 기본값은 **예전 동작**이다 - 클라우드에 시크릿을 넣고 한 번 도는 것을 확인하기 전에
    // 맥이 손을 떼면, 그 사이 온 링크는 아무도 받지 않고 24시간 뒤 사라진다.
    if (process.env.IG_INBOX_MODE === "true") {
      result = { processed: 0, enqueued: links, ignored: 0, topicsAnswered: topics };
    } else {
      result = await bot.pollOnce();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const state = recordFailure(OUTAGE_PATH, reason);
    console.error(`❌ [ig-capture-poll] 실패 ${state.failures}회째(${state.firstFailedAt}부터): ${reason}`);
    return;
  }

  // 여기까지 왔으면 네트워크가 살아 있다 - 멈춰 있었다면 지금이 알릴 수 있는 유일한 시점이다.
  const recovery = takeRecovery(OUTAGE_PATH);
  if (recovery) {
    console.log(`▶ [ig-capture-poll] ${recovery.hours}시간 만에 복구(실패 ${recovery.failures}회)`);
    await TelegramNotifier.fromEnv()
      .sendMessages([{ text: describeRecovery(recovery, "인스타 링크 수신") }])
      .catch(() => {});
  }

  if (result.processed > 0) {
    console.log(
      `▶ [ig-capture-poll] update ${result.processed}건 - 큐 적재 ${result.enqueued}건 / 주제 답장 ${result.topicsAnswered}건 / 무시 ${result.ignored}건`
    );
  }

  // 적재가 0건이어도 대기열은 볼 수 있어야 한다 - 이전 폴링에서 실패해 pending으로 남은 항목이
  // 다음 실행에서 재시도되는 경로다.
  const readiness = captureReadiness();
  if (!readiness.ready) {
    if (result.enqueued > 0) console.log(`⏭ [ig-capture-poll] ${readiness.reason}`);
    return;
  }

  const captured = await processPendingCaptures({
    // 읽을 글자가 하나도 없는 게시물은 실패가 아니라 질문거리다. 이 봇으로 물어야 답장을
    // 같은 봇이 받는다 - 메인 알림 봇으로 보내면 답장이 영영 돌아오지 않는다.
    askTopic: async (entry) =>
      bot.ask(
        entry.telegramChatId,
        [
          "📌 이 게시물에서 읽어낼 내용이 없습니다(캡션도, 이미지 속 글자도).",
          "어떤 주제로 쓸까요? 이 메시지에 답장해 주세요.",
          "",
          entry.instagramUrl,
        ].join("\n")
      ),
  });
  if (captured.attempted === 0) return;

  console.log(
    `▶ [ig-capture-poll] ${captured.attempted}건 처리 - 생성 ${captured.created} / 실패 ${captured.failed}` +
      (captured.givenUp > 0 ? ` / 포기 ${captured.givenUp}` : "") +
      (captured.asked > 0 ? ` / 주제 질문 ${captured.asked}` : "")
  );

  // 무인으로 도는 job이라 stdout을 아무도 안 본다. **사람이 손을 대야 하는 것만** 텔레그램으로
  // 알린다 - 재시도·포기·조사 발화 실패(2026-09-23 사용자 결정).
  //
  // 성공은 안 보낸다. URL을 보낼 때 봇이 "접수했습니다"로 답하고 집필이 끝나면 초안이 오므로,
  // 그 사이의 "캡처 처리됨"은 세 번째 알림이라 소음이다.
  if (captured.messages.length > 0) {
    await TelegramNotifier.fromEnv()
      .sendMessages([
        {
          text: `⚠️ <b>인스타 캡처 - 확인 필요</b>\n\n${captured.messages.map((m) => escapeTelegramHtml(m)).join("\n\n")}`,
        },
      ])
      .catch(() => {});
  }
}

main().catch((error) => {
  console.error("❌ [ig-capture-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
