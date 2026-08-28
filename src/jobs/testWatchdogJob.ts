// watchdog 판정 로직 테스트.
//
// 기본은 주입 의존성만 쓴다 - 실제 Supabase도 Telegram도 건드리지 않는다.
// 실제 채팅방 도착까지 확인하려면 `SEND=1 npm run test:watchdog` (stale run을 강제로 만들어 보냄).

import "dotenv/config";

import {
  evaluateWatchdog,
  formatWatchdogAlert,
  runWatchdog,
  seoulDateString,
} from "./watchdogJob.js";
import type { DiscoveryRunRow } from "../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeRun(startedAtIso: string, overrides: Partial<DiscoveryRunRow> = {}): DiscoveryRunRow {
  return {
    id: 42,
    started_at: startedAtIso,
    completed_at: startedAtIso,
    status: "completed",
    candidates_count: 2100,
    clusters_count: 400,
    inserted_count: 10,
    error_count: 0,
    source: "naver",
    seed_queries: null,
    metadata: null,
    created_at: startedAtIso,
    ...overrides,
  } as DiscoveryRunRow;
}

async function main(): Promise<void> {
  const shouldActuallySend = process.env.SEND === "1";
  console.log("▶ watchdog 테스트 시작\n");

  // 1) Seoul 날짜 경계: UTC 2026-08-27T16:30Z = KST 2026-08-28 01:30 → "2026-08-28"
  assert(
    seoulDateString(new Date("2026-08-27T16:30:00Z")) === "2026-08-28",
    "UTC 16:30은 KST로 다음 날이어야 한다"
  );
  assert(
    seoulDateString(new Date("2026-08-27T14:30:00Z")) === "2026-08-27",
    "UTC 14:30은 아직 KST 같은 날이어야 한다"
  );
  console.log("  ✅ Seoul 날짜 변환");

  // 2) 오늘 완료된 run이 있으면 ok
  const now = new Date("2026-08-28T02:00:00Z"); // KST 11:00
  const okVerdict = evaluateWatchdog(makeRun("2026-08-28T00:05:00Z"), now); // KST 09:05
  assert(okVerdict.ok, "같은 KST 날짜의 completed run은 ok여야 한다");
  console.log("  ✅ 오늘 성공 run → ok");

  // 3) 어제 run만 있으면 stale
  const staleVerdict = evaluateWatchdog(makeRun("2026-08-27T00:05:00Z", { id: 18 }), now);
  assert(!staleVerdict.ok && staleVerdict.reason === "stale_run", "어제 run은 stale_run이어야 한다");
  assert(!staleVerdict.ok && staleVerdict.lastRun.id === 18, "stale 알림에 마지막 run id가 있어야 한다");
  const staleMsg = formatWatchdogAlert(staleVerdict as never, now);
  assert(staleMsg.includes("run #18"), "알림 본문에 run 번호가 보여야 한다");
  console.log("  ✅ 어제 run만 존재 → stale_run 알림");

  // 4) run이 아예 없으면 no_completed_run
  const emptyVerdict = evaluateWatchdog(null, now);
  assert(!emptyVerdict.ok && emptyVerdict.reason === "no_completed_run", "run 없음 → no_completed_run");
  console.log("  ✅ run 없음 → no_completed_run 알림");

  // 5) runWatchdog: ok면 발송하지 않는다
  const okSends: string[] = [];
  const okResult = await runWatchdog({
    now,
    fetchLatest: async () => makeRun("2026-08-28T00:05:00Z"),
    send: async (text) => {
      okSends.push(text);
    },
  });
  assert(okResult.alerted === false && okSends.length === 0, "ok일 땐 알림을 보내지 않아야 한다");
  console.log("  ✅ ok → 발송 없음");

  // 6) runWatchdog: stale면 주입된 send가 호출된다
  const staleSends: string[] = [];
  const alertResult = await runWatchdog({
    now,
    fetchLatest: async () => makeRun("2026-08-26T00:05:00Z"),
    send: async (text) => {
      staleSends.push(text);
    },
  });
  assert(alertResult.alerted === true && staleSends.length === 1, "stale일 땐 알림을 보내야 한다");
  console.log("  ✅ stale → 발송 1회");

  // 7) send가 던져도 runWatchdog는 예외를 밖으로 내보내지 않는다
  const failResult = await runWatchdog({
    now,
    fetchLatest: async () => null,
    send: async () => {
      throw new Error("network down");
    },
  });
  assert(failResult.alerted === false && failResult.sendError === "network down", "발송 실패는 sendError로만 알린다");
  console.log("  ✅ 발송 실패 → 예외 없이 sendError");

  if (shouldActuallySend) {
    console.log("\n▶ SEND=1 - 실제 Telegram으로 stale 알림 발송");
    const real = await runWatchdog({
      now,
      fetchLatest: async () => makeRun("2000-01-01T00:00:00Z", { id: 0 }),
    });
    assert(real.alerted, `실제 발송 실패: ${real.sendError}`);
    console.log("  ✅ 실제 채팅방으로 발송됨");
  }

  console.log("\n✅ watchdog 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
