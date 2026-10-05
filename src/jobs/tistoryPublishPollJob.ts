// 티스토리 발행 폴러 - 맥미니에서만 돈다(TISTORY_AUTO_PUBLISH_DESIGN.md §1·§3). naverPublishPollJob.ts의 티스토리 판.
//
// 네이버 폴러와 다른 점 셋:
//   1. **로그인 풀림은 실패가 아니라 대기(deferred)** 다. 사회 트랙은 사용자가 바로 개입할 수 있는 트랙이라(사용자
//      전제), 사회 봇으로 "로그인 필요"를 한 번 알리고 재로그인되면 다음 주기에 알아서 다시 올린다. 3일 지난 대기
//      건은 자동 재개하지 않는다(사용자 결정) - 그 건은 하루 한 번 "다시 눌러야 한다"고 알린다.
//   2. 대기열이 비어 있어도 **하루 한 번(19:25~19:55 KST, 20시 리포트 직전) 로그인 상태를 점검**해 풀려 있으면
//      미리 알린다. 리포트를 보고 Go를 누르기 전에 로그인해 둘 수 있게.
//   3. 알림은 메인봇이 아니라 **그 job의 트랙 봇**(사회 봇)으로 간다(notifierForJob).
//
// 브라우저는 headless로 뜬다(본문은 TinyMCE API로 넣어 클립보드·포커스가 필요 없다) - 네이버 폴러(headed+클립보드)와
// 같은 시각에 돌아도 서로 방해하지 않는다.
//
// 실행: npm run job:tistory-poll  (launchd가 60초 주기로 부른다)
import "dotenv/config";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { TISTORY_CONFIG } from "../config/publishTargets.js";
import { escapeTelegramHtml, TelegramNotifier } from "../notifications/TelegramNotifier.js";
import { notifierForJob } from "../notifications/notifierForJob.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import { TistoryPublisher } from "../services/publish/tistory/TistoryPublisher.js";
import { publishJobToTistory } from "../workflows/publish/publishJobToTistory.js";
import {
  deferTistoryPublish,
  finishTistoryPublish,
  listExpiredDeferred,
  listPendingTistoryRequests,
  readTistoryRequest,
} from "../workflows/publish/tistoryPublishQueue.js";
import type { ArticleJobRow } from "../types/database.js";

/** 한 번에 처리할 최대 건수. 브라우저를 띄우는 작업이라 길게 돌면 다음 주기와 겹친다. */
const MAX_PER_RUN = 2;
/** 로그인 사전 점검 시간대(KST). 20시 사회 리포트 직전. */
const LOGIN_CHECK_WINDOW = { fromMinute: 19 * 60 + 25, toMinute: 19 * 60 + 55 };
/** 같은 사유 알림의 최소 간격 - 폴링마다 쏟아지지 않게. */
const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = resolve("logs/.tistory-poll-state.json");

type PollState = { loginCheckedOn?: string; loginLostNotifiedAt?: string; expiredNotifiedOn?: string };

function readState(): PollState {
  try {
    return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as PollState) : {};
  } catch {
    return {};
  }
}

function writeState(state: PollState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch {
    // 상태 파일 실패는 무시한다 - 최악의 경우 알림이 한 번 더 간다.
  }
}

function kstToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
}

function kstMinuteOfDay(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

async function notify(job: ArticleJobRow | null, text: string): Promise<void> {
  const notifier = job ? notifierForJob(job) : TelegramNotifier.fromEnv("social");
  await notifier.sendMessages([{ text }]).catch((error) => {
    console.warn(`⚠️ [tistory-poll] 알림 실패(무시하고 계속): ${error instanceof Error ? error.message : error}`);
  });
}

const LOGIN_GUIDE = "맥미니에서 <code>npm run setup:tistory</code>를 실행해 카카오 로그인하면 대기 중인 발행이 자동으로 이어집니다.";

async function processPending(pending: ArticleJobRow[], state: PollState): Promise<void> {
  console.log(`▶ [tistory-poll] 대기 ${pending.length}건 중 ${Math.min(pending.length, MAX_PER_RUN)}건 처리`);

  for (const job of pending.slice(0, MAX_PER_RUN)) {
    console.log(`   · ${job.keyword}`);
    const result = await publishJobToTistory(job.id);

    if (result.ok) {
      await finishTistoryPublish(job.id, { ok: true, url: result.url });
      console.log(`   ✅ ${job.keyword} -> ${result.url}`);
      const warnings = result.warnings ?? [];
      if (warnings.length > 0) console.warn(`   ⚠️ ${warnings.join(" / ")}`);
      await notify(
        job,
        [
          result.alreadyDone ? "ℹ️ <b>이미 티스토리에 올라가 있습니다</b>" : `🟠 <b>티스토리에 발행했습니다</b>${TISTORY_CONFIG.visibility === "private" ? " (비공개)" : ""}`,
          "",
          `<b>${escapeTelegramHtml(job.keyword)}</b>`,
          escapeTelegramHtml(result.url),
          ...(warnings.length > 0 ? ["", "⚠️ 확인이 필요합니다", ...warnings.map((w) => `· ${escapeTelegramHtml(w)}`)] : []),
        ].join("\n")
      );
      continue;
    }

    if (result.reason === "login_required") {
      // 실패가 아니라 대기다. 같은 사유 알림은 6시간에 한 번만.
      const request = readTistoryRequest(job);
      const lastNotified = request?.notifiedAt ?? state.loginLostNotifiedAt;
      const shouldNotify = !lastNotified || Date.now() - new Date(lastNotified).getTime() > REMINDER_INTERVAL_MS;
      await deferTistoryPublish(job, { notified: shouldNotify });
      console.log(`   ⏸ ${job.keyword} - 로그인 풀림, 대기로 전환`);
      if (shouldNotify) {
        state.loginLostNotifiedAt = new Date().toISOString();
        writeState(state);
        await notify(
          job,
          [
            "🔑 <b>티스토리 로그인이 풀려 발행을 미뤘습니다</b>",
            "",
            `<b>${escapeTelegramHtml(job.keyword)}</b>`,
            LOGIN_GUIDE,
            `${TISTORY_CONFIG.deferredMaxDays}일 안에 로그인하지 않으면 버튼을 다시 눌러야 합니다.`,
          ].join("\n")
        );
      }
      // 로그인이 풀렸으면 뒤의 건도 같은 결과다 - 브라우저를 더 띄우지 않는다.
      for (const rest of pending.slice(pending.indexOf(job) + 1, MAX_PER_RUN)) await deferTistoryPublish(rest);
      return;
    }

    if (result.reason === "disabled") {
      console.log(`   ⏭ ${job.keyword} - ${result.detail} (요청은 대기열에 남긴다)`);
      return;
    }

    await finishTistoryPublish(job.id, { ok: false, error: result.detail });
    console.error(`   ❌ ${job.keyword} - ${result.detail}`);
    await notify(
      job,
      [
        "⚠️ <b>티스토리 발행에 실패했습니다</b>",
        "",
        `<b>${escapeTelegramHtml(job.keyword)}</b>`,
        escapeTelegramHtml(result.detail),
        "",
        "자동 재시도는 없습니다 - 티스토리 발행 버튼을 다시 눌러주세요.",
      ].join("\n")
    );
  }
}

/** 대기열이 비었을 때 하루 한 번 로그인 상태를 미리 본다. */
async function dailyLoginCheck(state: PollState): Promise<void> {
  const today = kstToday();
  const minute = kstMinuteOfDay();
  if (state.loginCheckedOn === today) return;
  if (minute < LOGIN_CHECK_WINDOW.fromMinute || minute > LOGIN_CHECK_WINDOW.toMinute) return;

  state.loginCheckedOn = today;
  writeState(state);
  const check = await new TistoryPublisher().checkLogin();
  if (check.loggedIn) {
    console.log("· [tistory-poll] 로그인 점검: 정상");
    return;
  }
  console.log(`· [tistory-poll] 로그인 점검: 풀림(${check.reason})`);
  await notify(null, ["🔑 <b>티스토리 로그인이 풀려 있습니다</b>", "", "오늘 리포트에서 Go를 누르기 전에 미리 로그인해 두세요.", LOGIN_GUIDE].join("\n"));
}

/** 3일 넘게 로그인 대기였던 건은 자동 재개하지 않는다 - 하루 한 번만 알려 준다. */
async function remindExpired(state: PollState): Promise<void> {
  const today = kstToday();
  if (state.expiredNotifiedOn === today) return;
  const recent = await ArticleJobRepository.listRecent(100);
  const expired = listExpiredDeferred(recent, new Date());
  if (expired.length === 0) return;
  state.expiredNotifiedOn = today;
  writeState(state);
  await notify(
    expired[0],
    [
      `⏳ <b>${TISTORY_CONFIG.deferredMaxDays}일 넘게 로그인 대기였던 발행 ${expired.length}건은 자동으로 올리지 않습니다</b>`,
      "",
      ...expired.slice(0, 5).map((job) => `· ${escapeTelegramHtml(job.keyword)}`),
      "",
      "지금도 올리려면 원고 완료 알림의 🟠 티스토리 발행 버튼을 다시 눌러주세요.",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.tistory-poll.lock"));
  if (!lock) return;

  const state = readState();
  const pending = await listPendingTistoryRequests();
  if (pending.length > 0) {
    await processPending(pending, state);
  } else {
    await dailyLoginCheck(state);
  }
  await remindExpired(state);
}

main().catch((error) => {
  console.error(`❌ [tistory-poll] 실패: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
