// 외부 감시인(watchdog). "오늘 성공한 키워드 수집 run이 있는가"만 확인하고, 없으면 Telegram으로 알린다.
//
// 왜 필요한가(CURRENT_STATE.md "운영 노트: 잠자기로 인한 조용한 실패"):
// 매일 09:00 job이 caffeinate 보호를 받지만, 전원 차단·강제 재부팅·launchd 미발화 같은 경우엔
// 프로세스가 아예 시작되지 못하거나 강제 종료된다. 강제 종료된 프로세스는 notifyPipelineFailure를
// 실행할 수 없으므로, "실패했다"는 사실조차 아무도 모른다. 이 감시인은 그 구멍을 밖에서 막는다.
//
// 반드시 daily-keyword job과 다른 호스트에서 돌아야 의미가 있다(같은 맥이 꺼져 있으면 감시인도
// 안 돈다). GitHub Actions cron으로 실행하는 것을 전제로 한다 - docs/ai-handoff/CLOUD_MIGRATION.md.
//
// 이 스크립트는 Playwright도 claude CLI도 쓰지 않는다. Supabase 읽기 + Telegram 발송뿐이라
// CI로 그대로 올릴 수 있다. 의존성이 가벼운 것이 이 감시인의 핵심 설계 조건이다.
import "dotenv/config";

import { getLatestCompletedDiscoveryRun } from "../services/supabase/repositories/discoveryRunRepository.js";
import { TelegramNotifier } from "../notifications/TelegramNotifier.js";
import type { DiscoveryRunRow } from "../types/database.js";

const SEOUL_TZ = "Asia/Seoul";

/** Date를 Asia/Seoul 기준 YYYY-MM-DD 문자열로. run이 "오늘" 것인지 판정하는 데 쓴다. */
export function seoulDateString(date: Date): string {
  // en-CA 로케일은 YYYY-MM-DD 형식을 준다.
  return date.toLocaleDateString("en-CA", { timeZone: SEOUL_TZ });
}

export type WatchdogVerdict =
  | { ok: true; run: DiscoveryRunRow; runDate: string }
  | { ok: false; reason: "no_completed_run"; lastRun: null }
  | { ok: false; reason: "stale_run"; lastRun: DiscoveryRunRow; lastRunDate: string };

/** 최신 completed run이 "오늘(Seoul)" 것인지 판정한다. DB 조회 결과만 받는 순수 함수. */
export function evaluateWatchdog(
  latest: DiscoveryRunRow | null,
  now: Date
): WatchdogVerdict {
  const today = seoulDateString(now);

  if (!latest) {
    return { ok: false, reason: "no_completed_run", lastRun: null };
  }

  // started_at을 기준으로 본다(completed_at이 null인 채로 completed 표시된 과거 데이터 방어).
  const runDate = seoulDateString(new Date(latest.started_at));
  if (runDate === today) {
    return { ok: true, run: latest, runDate };
  }

  return { ok: false, reason: "stale_run", lastRun: latest, lastRunDate: runDate };
}

/** verdict를 사람이 읽을 알림 본문으로. ok일 때는 알림을 보내지 않으므로 실패 케이스만 만든다. */
export function formatWatchdogAlert(verdict: Extract<WatchdogVerdict, { ok: false }>, now: Date): string {
  const stamp = now.toLocaleString("ko-KR", { timeZone: SEOUL_TZ });
  const lines = [
    "🚨 키워드 수집 감시 알림",
    "",
    `점검 시각: ${stamp} (KST)`,
  ];

  if (verdict.reason === "no_completed_run") {
    lines.push("", "완료된 수집 run이 하나도 없습니다. daily-keyword job이 한 번도 성공하지 못했을 수 있습니다.");
  } else {
    lines.push(
      "",
      `오늘 완료된 수집 run이 없습니다.`,
      `마지막 성공: run #${verdict.lastRun.id} (${verdict.lastRunDate}, 상태 ${verdict.lastRun.status})`,
      "",
      "확인할 것: 맥 전원/네트워크, launchd 발화 여부(launchctl print ...), logs/daily-keyword.log",
    );
  }

  return lines.join("\n");
}

export type RunWatchdogOptions = {
  /** true면 알림을 실제로 보내지 않고 결과만 반환한다. */
  dryRun?: boolean;
  /** 테스트 주입 지점. 생략하면 실제 Supabase 조회. */
  fetchLatest?: () => Promise<DiscoveryRunRow | null>;
  /** 테스트 주입 지점. 생략하면 TelegramNotifier.fromEnv(). */
  send?: (text: string) => Promise<void>;
  /** 테스트 주입 지점. 생략하면 현재 시각. */
  now?: Date;
};

export type RunWatchdogResult = {
  verdict: WatchdogVerdict;
  alerted: boolean;
  /** 보낸(혹은 dryRun이면 보낼 예정인) 알림 본문. ok일 땐 undefined. */
  message?: string;
  /** 발송 실패 사유. 이 함수는 알림 발송 실패로 예외를 던지지 않는다. */
  sendError?: string;
};

export async function runWatchdog(options: RunWatchdogOptions = {}): Promise<RunWatchdogResult> {
  const now = options.now ?? new Date();
  const fetchLatest = options.fetchLatest ?? getLatestCompletedDiscoveryRun;

  const latest = await fetchLatest();
  const verdict = evaluateWatchdog(latest, now);

  if (verdict.ok) {
    return { verdict, alerted: false };
  }

  const message = formatWatchdogAlert(verdict, now);

  if (options.dryRun) {
    return { verdict, alerted: false, message };
  }

  const send = options.send ?? ((text: string) => TelegramNotifier.fromEnv().send(text));
  try {
    await send(message);
    return { verdict, alerted: true, message };
  } catch (error) {
    return {
      verdict,
      alerted: false,
      message,
      sendError: error instanceof Error ? error.message : String(error),
    };
  }
}

// 직접 실행 진입점.
const isDirectRun = process.argv[1]?.endsWith("watchdogJob.ts") || process.argv[1]?.endsWith("watchdogJob.js");
if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  runWatchdog({ dryRun })
    .then((result) => {
      if (result.verdict.ok) {
        console.log(`✅ [watchdog] 오늘 성공 run 있음 - run #${result.verdict.run.id} (${result.verdict.runDate})`);
        return;
      }

      console.error(`🚨 [watchdog] ${result.verdict.reason}`);
      if (result.message) console.error(result.message);

      if (result.sendError) {
        console.error(`⚠️ 알림 발송 실패: ${result.sendError}`);
        process.exit(2);
      }
      if (dryRun) {
        console.error("(dry-run: 실제 발송하지 않음)");
      } else {
        console.error("알림 발송 완료.");
      }
      // 감시인이 문제를 찾았다는 것 자체는 CI를 빨갛게 만들어야 눈에 띈다.
      process.exit(1);
    })
    .catch((error) => {
      console.error("❌ [watchdog] 실패:", error instanceof Error ? error.message : error);
      process.exit(3);
    });
}
