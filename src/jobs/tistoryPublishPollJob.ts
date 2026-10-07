// 티스토리 발행 폴러 - 맥미니에서만 돈다(TISTORY_AUTO_PUBLISH_DESIGN.md §1·§3). naverPublishPollJob.ts의 티스토리 판.
//
// 네이버 폴러와 다른 점 셋:
//   1. **로그인 풀림은 실패가 아니라 대기(deferred)** 다. 사회 트랙은 사용자가 바로 개입할 수 있는 트랙이라(사용자
//      전제), 사회 봇으로 "로그인 필요"를 한 번 알리고 재로그인되면 다음 주기에 알아서 다시 올린다. 3일 지난 대기
//      건은 자동 재개하지 않는다(사용자 결정) - 그 건은 하루 한 번 "다시 눌러야 한다"고 알린다.
//   2. 대기열이 비어 있어도 **keepalive**(기본 3시간 간격, TISTORY_KEEPALIVE_HOURS)로 관리 화면을 열어 세션을 만진다
//      (2026-10-07 - 쿠키 보관에도 세션이 하루 안에 죽은 실측. 카카오가 토큰을 돌릴 때마다 쿠키를 따라 갱신해야 수명이
//      는다). 성공하면 쿠키 보관함이 갱신되고, 풀려 있으면 알린다(6시간 중복 방지). 20시 사회 리포트 직전
//      (19:25~19:55)에는 간격과 무관하게 한 번 보장한다 - Go를 누르기 전에 미리 알 수 있게.
//   3. 알림은 메인봇이 아니라 **그 job의 트랙 봇**(사회 봇)으로 간다(notifierForJob).
//
// 브라우저는 headless로 뜬다(본문은 TinyMCE API로 넣어 클립보드·포커스가 필요 없다) - 네이버 폴러(headed+클립보드)와
// 같은 시각에 돌아도 서로 방해하지 않는다.
//
// 실행: npm run job:tistory-poll  (launchd가 60초 주기로 부른다)
import "dotenv/config";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  isDueForAttempt,
  listExpiredDeferred,
  listPendingTistoryRequests,
  readTistoryRequest,
} from "../workflows/publish/tistoryPublishQueue.js";
import type { ArticleJobRow } from "../types/database.js";

/** 한 번에 처리할 최대 건수. 브라우저를 띄우는 작업이라 길게 돌면 다음 주기와 겹친다. */
const MAX_PER_RUN = 2;
/** 20시 사회 리포트 직전에는 간격과 무관하게 keepalive를 한 번 보장하는 시간대(KST). */
const LOGIN_CHECK_WINDOW = { fromMinute: 19 * 60 + 25, toMinute: 19 * 60 + 55 };

/** keepalive 간격(시간). 0이면 끔(리포트 직전 보장만 남는다). */
function keepaliveHours(): number {
  const raw = Number.parseFloat(process.env.TISTORY_KEEPALIVE_HOURS ?? "");
  return Number.isNaN(raw) || raw < 0 ? 3 : raw;
}
/** 같은 사유 알림의 최소 간격 - 폴링마다 쏟아지지 않게. */
const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = resolve("logs/.tistory-poll-state.json");

export type PollState = {
  /** (구) 하루 1회 점검 날짜. keepalive 도입으로 더는 쓰지 않지만 옛 상태 파일과의 호환으로 남긴다. */
  loginCheckedOn?: string;
  loginLostNotifiedAt?: string;
  expiredNotifiedOn?: string;
  /** 마지막 keepalive(또는 발행으로 세션을 만진) 시각. */
  lastKeepaliveAt?: string;
};

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

/** 테스트가 브라우저·DB·텔레그램 없이 processPending을 돌리도록 바꿔 끼우는 지점. 기본은 실제 구현. */
export type PollDeps = {
  publish: typeof publishJobToTistory;
  finish: typeof finishTistoryPublish;
  defer: typeof deferTistoryPublish;
  notify: (job: ArticleJobRow | null, text: string) => Promise<void>;
  saveState: (state: PollState) => void;
};

const defaultDeps: PollDeps = {
  publish: publishJobToTistory,
  finish: finishTistoryPublish,
  defer: deferTistoryPublish,
  notify,
  saveState: writeState,
};

async function notify(job: ArticleJobRow | null, text: string): Promise<void> {
  const notifier = job ? notifierForJob(job) : TelegramNotifier.fromEnv("social");
  await notifier.sendMessages([{ text }]).catch((error) => {
    console.warn(`⚠️ [tistory-poll] 알림 실패(무시하고 계속): ${error instanceof Error ? error.message : error}`);
  });
}

const LOGIN_GUIDE = "맥미니에서 <code>npm run setup:tistory</code>를 실행해 카카오 로그인하면 대기 중인 발행이 자동으로 이어집니다.";

function failureMessage(job: ArticleJobRow, detail: string): string {
  return [
    "⚠️ <b>티스토리 발행에 실패했습니다</b>",
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
    escapeTelegramHtml(detail),
    "",
    "자동 재시도는 없습니다 - 티스토리 발행 버튼을 다시 눌러주세요.",
  ].join("\n");
}

export async function processPending(pending: ArticleJobRow[], state: PollState, deps: PollDeps = defaultDeps): Promise<void> {
  console.log(`▶ [tistory-poll] 대기 ${pending.length}건 중 ${Math.min(pending.length, MAX_PER_RUN)}건 처리`);

  for (const job of pending.slice(0, MAX_PER_RUN)) {
    console.log(`   · ${job.keyword}`);
    let result: Awaited<ReturnType<typeof publishJobToTistory>>;
    try {
      result = await deps.publish(job.id);
    } catch (error) {
      // 예외로 폴러가 죽으면 요청이 requested로 남아 60초마다 같은 글을 다시 집는다 - 실패로 기록하고 알린 뒤 다음 건으로.
      // (발행 성공 후 기록 실패는 publishJobToTistory가 published_unrecorded로 따로 돌려준다 - 여기는 그 이전 단계의 예외다.)
      const detail = error instanceof Error ? error.message : String(error);
      await deps.finish(job.id, { ok: false, error: detail }).catch(() => {});
      console.error(`   ❌ ${job.keyword} - 예외: ${detail}`);
      process.exitCode = 1;
      await deps.notify(job, failureMessage(job, `예외: ${detail}`));
      continue;
    }

    if (result.ok) {
      await deps.finish(job.id, { ok: true, url: result.url });
      console.log(`   ✅ ${job.keyword} -> ${result.url}`);
      const warnings = result.warnings ?? [];
      if (warnings.length > 0) console.warn(`   ⚠️ ${warnings.join(" / ")}`);
      await deps.notify(
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
      await deps.defer(job, { notified: shouldNotify });
      console.log(`   ⏸ ${job.keyword} - 로그인 풀림, 대기로 전환`);
      if (shouldNotify) {
        state.loginLostNotifiedAt = new Date().toISOString();
        deps.saveState(state);
        await deps.notify(
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
      for (const rest of pending.slice(pending.indexOf(job) + 1, MAX_PER_RUN)) await deps.defer(rest);
      return;
    }

    if (result.reason === "disabled") {
      console.log(`   ⏭ ${job.keyword} - ${result.detail} (요청은 대기열에 남긴다)`);
      return;
    }

    if (result.reason === "published_unrecorded") {
      // 이미 올라간 글이다 - 재시도 큐로 되돌리면 같은 글이 또 올라간다. 별도 상태로 남겨 폴러가 다시 집지 않게 한다.
      await deps.finish(job.id, { ok: "unrecorded", url: result.url, error: result.detail }).catch(() => {});
      console.error(`   ⚠️ ${job.keyword} - ${result.detail} (${result.url})`);
      process.exitCode = 1;
      await deps.notify(
        job,
        [
          "🚨 <b>티스토리에는 올라갔지만 기록에 실패했습니다</b>",
          "",
          `<b>${escapeTelegramHtml(job.keyword)}</b>`,
          escapeTelegramHtml(result.url),
          escapeTelegramHtml(result.detail),
          "",
          "중복 발행을 막기 위해 자동으로 다시 올리지 않습니다 - 티스토리에 글이 있는지 직접 확인해 주세요.",
        ].join("\n")
      );
      continue;
    }

    await deps.finish(job.id, { ok: false, error: result.detail });
    console.error(`   ❌ ${job.keyword} - ${result.detail}`);
    await deps.notify(job, failureMessage(job, result.detail));
  }
}

/**
 * keepalive를 지금 돌릴지. 순수 함수(테스트: testTistoryPublishPollJob.ts).
 *  - 마지막 keepalive에서 intervalHours가 지났으면 true.
 *  - 리포트 직전 시간대(19:25~19:55 KST)에는 그 날 그 시간대에 아직 안 돌았으면 간격과 무관하게 true.
 *  - intervalHours 0은 끔(시간대 보장만 남는다).
 */
export function shouldRunKeepalive(state: PollState, now: Date, intervalHours: number = keepaliveHours()): boolean {
  const last = state.lastKeepaliveAt ? new Date(state.lastKeepaliveAt).getTime() : NaN;
  const minute = kstMinuteOfDay(now);
  const inWindow = minute >= LOGIN_CHECK_WINDOW.fromMinute && minute <= LOGIN_CHECK_WINDOW.toMinute;
  if (Number.isNaN(last)) return intervalHours > 0 || inWindow;
  if (inWindow) {
    // 이 시간대 시작 시각(KST 19:25를 now 기준으로 환산) 이후에 이미 돌았으면 중복하지 않는다.
    const windowStart = now.getTime() - (minute - LOGIN_CHECK_WINDOW.fromMinute) * 60 * 1000;
    if (last < windowStart) return true;
  }
  if (intervalHours <= 0) return false;
  return now.getTime() - last >= intervalHours * 60 * 60 * 1000;
}

/**
 * 대기열이 비었을 때 세션을 만져 살려 둔다(keepalive). checkLogin이 성공하면 쿠키 보관함도 갱신된다
 * (TistoryPublisher.checkLogin -> refreshSavedCookies). 풀려 있으면 알리되 6시간에 한 번만.
 */
async function keepalive(state: PollState): Promise<void> {
  if (!shouldRunKeepalive(state, new Date())) return;
  state.lastKeepaliveAt = new Date().toISOString();
  writeState(state);
  const check = await new TistoryPublisher().checkLogin();
  if (check.loggedIn) {
    console.log("· [tistory-poll] keepalive: 로그인 정상, 쿠키 갱신");
    return;
  }
  console.log(`· [tistory-poll] keepalive: 로그인 풀림(${check.reason})`);
  const lastNotified = state.loginLostNotifiedAt ? new Date(state.loginLostNotifiedAt).getTime() : 0;
  if (Date.now() - lastNotified < REMINDER_INTERVAL_MS) return;
  state.loginLostNotifiedAt = new Date().toISOString();
  writeState(state);
  await notify(null, ["🔑 <b>티스토리 로그인이 풀려 있습니다</b>", "", "다음 발행 전에 미리 로그인해 두세요.", LOGIN_GUIDE].join("\n"));
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

/** 이번 주기에 처리할 건. 로그인 대기(deferred)는 재확인 간격 안이면 뺀다 - 브라우저를 띄우지 않는다(B-1). */
export function selectDueRequests(waiting: ArticleJobRow[], now: Date): ArticleJobRow[] {
  return waiting.filter((job) => {
    const request = readTistoryRequest(job);
    return !request || isDueForAttempt(request, now);
  });
}

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.tistory-poll.lock"));
  if (!lock) return;

  const state = readState();
  const waiting = await listPendingTistoryRequests();
  // 로그인 대기(deferred) 건은 재확인 간격 안이면 이번엔 건너뛴다 - 브라우저를 띄우지 않는다(B-1).
  const pending = selectDueRequests(waiting, new Date());
  if (waiting.length > pending.length) {
    console.log(`· [tistory-poll] 로그인 대기 ${waiting.length - pending.length}건은 재확인 간격 전이라 건너뜁니다.`);
  }
  if (pending.length > 0) {
    await processPending(pending, state);
    // 발행 시도도 세션을 만진다(성공 시 쿠키 갱신 포함) - 직후에 keepalive 브라우저를 또 띄우지 않는다.
    state.lastKeepaliveAt = new Date().toISOString();
    writeState(state);
  } else if (waiting.length === 0) {
    // keepalive 단계의 예외(브라우저 기동·로그인 확인)가 만료 알림까지 막지 않게 따로 감싼다.
    await keepalive(state).catch((error) => {
      console.warn(`⚠️ [tistory-poll] keepalive 실패(무시하고 계속): ${error instanceof Error ? error.message : error}`);
    });
  }
  await remindExpired(state);
}

// 테스트가 이 파일을 import해도 폴러가 돌지 않게 한다(npm run job:tistory-poll로 직접 실행할 때만).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ [tistory-poll] 실패: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
