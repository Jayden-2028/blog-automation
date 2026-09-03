// approved 발행 대기열을 비우는 폴러. launchd가 주기적으로 실행한다. SPRINT_5_DESIGN.md §5.
//
// telegram-poll과 같은 구조(짧게 반복 실행 + caffeinate + 파일 락). 승인 콜백 안에서 발행하지
// 않는 이유는 publishApprovedArticles.ts 상단 주석 참고 - 배리에이션 LLM/티스토리 Playwright가
// 수 분 걸려 콜백을 멈추고, 잠자기 중 죽으면 발행이 유실된다.
//
// 발행 시각 분산: 폴링 주기(launchd StartInterval 600) + 아래 랜덤 지터로, 승인 직후 정각에
// 여러 채널을 몰아 올리지 않는다(§6 - 스팸 필터 방어).
import "dotenv/config";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { TelegramNotifier } from "../notifications/TelegramNotifier.js";
import { publishApprovedArticles } from "../workflows/publish/publishApprovedArticles.js";
import { notifyMultiPublish } from "../workflows/publish/notifyMultiPublish.js";

const MAX_JITTER_MS = 90_000;
const TISTORY_LOGIN_MARKER = resolve("logs/.tistory-login-alerted");

/** 티스토리 로그인 만료 알림은 하루 1회만(폴러가 10분마다 도므로 매번 알리면 스팸). */
async function alertTistoryLoginOncePerDay(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  try {
    if (existsSync(TISTORY_LOGIN_MARKER) && readFileSync(TISTORY_LOGIN_MARKER, "utf8").trim() === today) return;
  } catch {
    // 마커 읽기 실패 - 알림은 보낸다.
  }
  await TelegramNotifier.fromEnv()
    .sendMessages([
      {
        text:
          "🔑 <b>티스토리 로그인 필요</b>\n\n카카오 세션이 만료돼 티스토리 임시저장이 보류 중입니다.\n" +
          "맥에서 <code>npm run setup:tistory</code>로 재로그인하면 대기 중인 글이 다음 폴링에 자동 저장됩니다.\n" +
          "(네이버·Blogspot는 정상 동작 중)",
      },
    ])
    .catch(() => {});
  try {
    writeFileSync(TISTORY_LOGIN_MARKER, today, "utf8");
  } catch {
    // 마커 쓰기 실패해도 진행 - 최악의 경우 다음 폴링에 한 번 더 알린다.
  }
}

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.publish-poll.lock"));
  if (!lock) return;

  // 랜덤 지터. 이전 실행이 락으로 걸러진 뒤라 여기서 자도 겹치지 않는다.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * MAX_JITTER_MS)));

  const results = await publishApprovedArticles();
  if (results.length === 0) return; // 대기열 없음 - 조용히 종료

  console.log(`▶ [publish-poll] approved job ${results.length}건 처리`);
  let hadFailure = false;
  let tistoryLoginNeeded = false;
  for (const { job, channels, markedPublished } of results) {
    for (const c of channels) {
      const detail = c.status === "published" || c.status === "draft" || c.status === "already_done" ? c.url : (("reason" in c && c.reason) || "");
      console.log(`   [${c.channel}] ${c.status}${detail ? ` - ${detail}` : ""} (job ${job.id})`);
      if (c.status === "failed") hadFailure = true;
      if (c.channel === "tistory" && c.status === "deferred" && "reason" in c && /로그인/.test(c.reason)) {
        tistoryLoginNeeded = true;
      }
    }
    if (markedPublished) console.log(`   ✅ job ${job.id} -> published`);
  }

  await notifyMultiPublish(results);
  if (tistoryLoginNeeded) await alertTistoryLoginOncePerDay();

  if (hadFailure) {
    // Telegram 알림은 notifyMultiPublish가 채널별로 이미 더 자세히 보냈다(위에서 호출).
    // 여기서는 launchd 로그에만 남긴다 - 중복 알림 방지.
    const failedLines = results.flatMap(({ job, channels }) =>
      channels
        .filter((c) => c.status === "failed")
        .map((c) => `${job.keyword} / ${c.channel}: ${"reason" in c ? c.reason : ""}`)
    );
    console.error(failedLines.join("\n"));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ [publish-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
