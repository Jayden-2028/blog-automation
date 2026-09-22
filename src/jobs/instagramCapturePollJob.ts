// 인스타 포스팅 변환기 봇 폴링 진입점. telegramPollJob.ts와 같은 패턴(launchd가 짧게 반복 실행,
// offset은 telegram_offsets에 별도 receiverId로 보관, 동시 실행은 파일 락으로 막는다).
//
// 이 job이 하는 일은 URL을 큐에 적재하는 것뿐이다. 캐러셀 캡처·job 생성은 여기서 하지 않는다
// (브라우저가 필요해 헤드리스로 못 한다) - npm run ig:capture-status로 대기열을 확인하고,
// 사람(Claude 인터랙티브 세션)이 직접 처리한다.
import "dotenv/config";

import { resolve } from "node:path";

import { InstagramCaptureBot } from "../notifications/InstagramCaptureBot.js";
import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.instagram-capture-poll.lock"));
  if (!lock) return;

  const bot = InstagramCaptureBot.fromEnv();
  const result = await bot.pollOnce();

  if (result.processed === 0) return;
  console.log(
    `▶ [ig-capture-poll] update ${result.processed}건 - 큐 적재 ${result.enqueued}건 / 무시 ${result.ignored}건`
  );
}

main().catch((error) => {
  console.error("❌ [ig-capture-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
