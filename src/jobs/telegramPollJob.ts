// Telegram 수신 폴링 진입점. launchd가 주기적으로 이 스크립트를 실행한다.
//
// 상시 프로세스가 아니라 짧게 반복 실행하는 이유(SPRINT_1_DESIGN.md 6절): 이 맥은 유휴 1분이면
// 잠들고, 상시 프로세스는 그때 죽는다. 짧은 실행은 잠자기와 무관하게 매번 새로 시작한다.
// getUpdates 커서는 telegram_offsets에 보관하므로 프로세스가 죽어도 이어서 처리한다.
//
// 처리할 update가 없으면 조용히 끝난다 - 5분마다 도는 job이 매번 로그를 남기면 로그가 쓸모없어진다.
import "dotenv/config";

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { TelegramBot } from "../notifications/TelegramBot.js";
import { TelegramNotifier } from "../notifications/TelegramNotifier.js";
import { generateTitleSuggestions } from "../workflows/keyword-notification/generateTitleSuggestions.js";
import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";

// 2026-09-02: Supabase DNS 장애가 6시간 이어지는 동안 폴러는 launchd로 계속 정상 실행됐지만
// 매번 조용히 실패했고, 아무 알림도 안 가서 사용자가 몰랐다(로그에만 남음). 실패는 알리되,
// 인프라 장애가 몇 시간 이어져도 5분마다 스팸이 되지 않게 최소 간격을 둔다.
const POLL_FAILURE_MARKER = resolve("logs/.telegram-poll-failure-alerted");
const ALERT_THROTTLE_MS = 30 * 60 * 1000;

async function alertPollFailureThrottled(reason: string): Promise<void> {
  try {
    if (existsSync(POLL_FAILURE_MARKER)) {
      const last = Number(readFileSync(POLL_FAILURE_MARKER, "utf8").trim());
      if (Number.isFinite(last) && Date.now() - last < ALERT_THROTTLE_MS) return;
    }
  } catch {
    // 마커 읽기 실패 - 알림은 보낸다.
  }
  await TelegramNotifier.fromEnv()
    .sendMessages([
      {
        text:
          `🚨 <b>텔레그램 폴러 실패</b>\n\n${reason}\n\n` +
          `버튼 클릭이 처리되지 않고 있을 수 있습니다. 네트워크/DNS 상태를 확인해주세요.`,
      },
    ])
    .catch(() => {});
  try {
    writeFileSync(POLL_FAILURE_MARKER, String(Date.now()), "utf8");
  } catch {
    // 마커 쓰기 실패해도 진행 - 최악의 경우 다음 폴링에 한 번 더 알린다.
  }
}

/** 이전에 실패 알림이 나갔던 상태에서 이번 폴링이 성공하면 복구를 알린다. */
async function alertPollRecoveredIfNeeded(): Promise<void> {
  if (!existsSync(POLL_FAILURE_MARKER)) return;
  try {
    unlinkSync(POLL_FAILURE_MARKER);
  } catch {
    return;
  }
  await TelegramNotifier.fromEnv()
    .sendMessages([{ text: "✅ 텔레그램 폴러가 복구됐습니다. 그동안 안 눌린 버튼이 있다면 다시 눌러주세요." }])
    .catch(() => {});
}

async function main(): Promise<void> {
  // Go 콜백이 자료조사(최대 3분)를, 원고 작성 버튼이 집필(최대 5분)을 콜백 처리 안에서 동기
  // 실행한다. 5분 주기를 넘기면 다음 launchd 발화가 겹치므로 파일 락으로 동시 실행을 막는다.
  const lock = acquireSingleInstanceLock(resolve("logs/.telegram-poll.lock"));
  if (!lock) {
    // 이전 실행이 아직 돌고 있다 - 조용히 끝낸다. 다음 주기에 다시 시도한다.
    return;
  }

  const bot = TelegramBot.fromEnv({
    generateTitles: (job) =>
      generateTitleSuggestions({ keyword: job.keyword, headline: job.headline, category: job.category }),
  });

  let pollResult: Awaited<ReturnType<typeof bot.pollOnce>>;
  try {
    pollResult = await bot.pollOnce();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await alertPollFailureThrottled(`offset/update 조회 자체가 실패했습니다: ${reason}`);
    throw error;
  }
  await alertPollRecoveredIfNeeded();

  const { processed, results, reviewResults, researchDecisionResults, researchTriggerResults, errors } = pollResult;

  if (processed === 0) return;

  console.log(`▶ [telegram-poll] update ${processed}건 수신`);
  for (const result of results) {
    const { outcome } = result;
    switch (outcome.status) {
      case "created":
        console.log(`   ✅ 선택 -> job ${outcome.job.id} (${outcome.job.keyword})`);
        break;
      case "passed":
        console.log(`   ⏭ 넘김 -> job ${outcome.job.id} (${outcome.job.keyword})`);
        break;
      case "changed":
        console.log(`   ↔︎ 변경 ${outcome.from} -> ${outcome.job.status} (job ${outcome.job.id})`);
        break;
      case "unchanged":
        console.log(`   ↩︎ 이미 같은 결정 -> job ${outcome.job.id} (상태: ${outcome.job.status})`);
        break;
      case "locked":
        console.log(`   🔒 진행 중이라 변경 불가 -> job ${outcome.job.id} (상태: ${outcome.job.status})`);
        break;
      case "expired":
        console.log(`   ⌛ 만료된 항목`);
        break;
      case "ignored":
        console.log(`   · 무시 (${outcome.reason})`);
        break;
    }
  }

  for (const result of reviewResults) {
    const { outcome } = result;
    if (outcome.status === "reviewed") {
      console.log(`   ⚕️ 의학 교차확인 ${outcome.action} -> job ${outcome.job.id} (${outcome.job.keyword})`);
    } else if (outcome.status === "job_not_found") {
      console.log(`   · 의학 교차확인: job을 찾을 수 없음`);
    }
  }

  for (const { job } of researchTriggerResults) {
    console.log(`   🔍 자료조사 시작(detached) -> job ${job.id} (${job.keyword})`);
  }

  for (const result of researchDecisionResults) {
    const { outcome } = result;
    if (outcome.status === "rejected") {
      console.log(`   🗑 조사 후 중단 -> job ${outcome.job.id} (${outcome.job.keyword})`);
    } else if (outcome.status === "write_started") {
      console.log(`   ✍️ 원고 작성 시작(detached) -> job ${outcome.job.id} (${outcome.job.keyword})`);
    } else if (outcome.status === "already_final") {
      console.log(`   ↩︎ 조사 체크포인트: 이미 처리됨 -> job ${outcome.job.id} (상태: ${outcome.job.status})`);
    } else if (outcome.status === "job_not_found") {
      console.log(`   · 조사 체크포인트: job을 찾을 수 없음`);
    }
  }

  for (const error of errors) {
    console.error(`   ⚠️ ${error}`);
  }

  // update 처리 중 오류가 있었으면 launchd 로그에서 실패로 보이게 한다.
  if (errors.length > 0) {
    process.exitCode = 1;
    await alertPollFailureThrottled(`update 처리 중 ${errors.length}건 실패:\n${errors.join("\n")}`);
  }
}

main().catch((error) => {
  console.error("❌ [telegram-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
