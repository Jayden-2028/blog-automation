// 네이버 발행 폴러 - 맥에서만 돈다(2026-09-22 네이버 운영 재개).
//
// 왜 로컬인가: 네이버는 공식 발행 API가 없어 **로그인된 브라우저**를 조작해야 한다. GitHub
// Actions에는 로그인 세션도, 본문 붙여넣기에 쓰는 실제 OS 클립보드도 없다. 그래서 클라우드는
// 텔레그램 버튼을 받아 "올려달라"는 요청만 job.metadata에 남기고, 이 폴러가 집어 간다.
//
// 2026-09-14에 로컬 폴링을 영구 비활성화했었다. 그 결정은 **Blogspot 발행 폴러**에 대한
// 것이었고(공식 API라 클라우드로 옮길 수 있었다), 네이버는 옮길 수가 없어 예외로 되살린다.
//
// 맥이 꺼져 있으면 그동안 처리되지 않는다 - 요청은 DB에 남으므로 켜지면 이어서 돈다.
//
// 실행: npm run job:naver-poll  (launchd가 1~2분 주기로 부른다)
import "dotenv/config";

import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import {
  finishNaverPublish,
  listPendingNaverRequests,
} from "../workflows/publish/naverPublishQueue.js";
import { publishJobToNaver } from "../workflows/publish/publishJobToNaver.js";
import { TelegramNotifier, escapeTelegramHtml } from "../notifications/TelegramNotifier.js";

/** 한 번에 처리할 최대 건수. 브라우저를 띄우는 작업이라 길게 돌면 다음 주기와 겹친다. */
const MAX_PER_RUN = 2;

async function notify(text: string): Promise<void> {
  await TelegramNotifier.fromEnv()
    .sendMessages([{ text }])
    .catch((error) => {
      console.warn(`⚠️ [naver-poll] 알림 실패(무시하고 계속): ${error instanceof Error ? error.message : error}`);
    });
}

async function main(): Promise<void> {
  // 브라우저를 띄우는 작업이라 겹쳐 돌면 서로의 창을 방해한다. 락이 없으면 조용히 끝낸다.
  const lock = acquireSingleInstanceLock(resolve("logs/.naver-poll.lock"));
  if (!lock) return;

  const pending = await listPendingNaverRequests();
  if (pending.length === 0) return; // 대기열 없음 - 조용히 종료

  console.log(`▶ [naver-poll] 대기 ${pending.length}건 중 ${Math.min(pending.length, MAX_PER_RUN)}건 처리`);

  for (const job of pending.slice(0, MAX_PER_RUN)) {
    console.log(`   · ${job.keyword}`);
    try {
      const result = await publishJobToNaver(job.id);
      if (result.ok) {
        await finishNaverPublish(job.id, { ok: true, url: result.url });
        console.log(`   ✅ ${job.keyword} -> ${result.url}`);
        await notify(
          [
            result.alreadyDone ? "ℹ️ <b>이미 네이버에 올라가 있습니다</b>" : "🟢 <b>네이버에 발행했습니다</b>",
            "",
            `<b>${escapeTelegramHtml(job.keyword)}</b>`,
            escapeTelegramHtml(result.url),
          ].join("\n")
        );
      } else {
        await finishNaverPublish(job.id, { ok: false, error: result.detail });
        console.error(`   ❌ ${job.keyword} - ${result.detail}`);
        await notify(
          [
            "⚠️ <b>네이버 발행에 실패했습니다</b>",
            "",
            `<b>${escapeTelegramHtml(job.keyword)}</b>`,
            escapeTelegramHtml(result.detail),
            "",
            "자동 재시도는 없습니다 - 네이버 발행 버튼을 다시 눌러주세요.",
          ].join("\n")
        );
        process.exitCode = 1;
      }
    } catch (error) {
      // 예외로 폴러가 죽으면 다음 건이 영영 안 돈다 - 기록하고 다음으로 넘어간다.
      const detail = error instanceof Error ? error.message : String(error);
      await finishNaverPublish(job.id, { ok: false, error: detail }).catch(() => {});
      console.error(`   ❌ ${job.keyword} - 예외: ${detail}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error("❌ [naver-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
