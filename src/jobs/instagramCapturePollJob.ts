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
import { TelegramNotifier, escapeTelegramHtml } from "../notifications/TelegramNotifier.js";
import { captureReadiness, processPendingCaptures } from "../workflows/instagram-capture/processPendingCaptures.js";
import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.instagram-capture-poll.lock"));
  if (!lock) return;

  const bot = InstagramCaptureBot.fromEnv();
  const result = await bot.pollOnce();

  if (result.processed > 0) {
    console.log(
      `▶ [ig-capture-poll] update ${result.processed}건 - 큐 적재 ${result.enqueued}건 / 무시 ${result.ignored}건`
    );
  }

  // 적재가 0건이어도 대기열은 볼 수 있어야 한다 - 이전 폴링에서 실패해 pending으로 남은 항목이
  // 다음 실행에서 재시도되는 경로다.
  const readiness = captureReadiness();
  if (!readiness.ready) {
    if (result.enqueued > 0) console.log(`⏭ [ig-capture-poll] ${readiness.reason}`);
    return;
  }

  const captured = await processPendingCaptures();
  if (captured.attempted === 0) return;

  console.log(
    `▶ [ig-capture-poll] 캡처 ${captured.attempted}건 시도 - 생성 ${captured.created} / 실패 ${captured.failed}` +
      (captured.givenUp > 0 ? ` / 포기 ${captured.givenUp}` : "")
  );

  // 무인으로 도는 job이라 stdout을 아무도 안 본다. 결과는 텔레그램으로 알린다 - 성공도 알려야
  // "보냈는데 아무 일도 없다"를 사용자가 겪지 않는다.
  if (captured.messages.length > 0) {
    await TelegramNotifier.fromEnv()
      .sendMessages([
        {
          text: `📥 <b>인스타 캡처 처리</b>\n\n${captured.messages.map((m) => escapeTelegramHtml(m)).join("\n\n")}`,
        },
      ])
      .catch(() => {});
  }
}

main().catch((error) => {
  console.error("❌ [ig-capture-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
