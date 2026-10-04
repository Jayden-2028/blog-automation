// watchdog 판정 로직 테스트.
//
// 기본은 주입 의존성만 쓴다 - 실제 Supabase도 Telegram도 건드리지 않는다.
// 실제 채팅방 도착까지 확인하려면 `SEND=1 npm run test:watchdog` (stale run을 강제로 만들어 보냄).

import "dotenv/config";

import {
  collectionDayString,
  evaluateWatchdog,
  evaluateWatchdogByJob,
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
  console.log("  ✅ 어제 run만 존재 → stale_run");

  // 4) run이 아예 없으면 no_completed_run
  const emptyVerdict = evaluateWatchdog(null, now);
  assert(!emptyVerdict.ok && emptyVerdict.reason === "no_completed_run", "run 없음 → no_completed_run");
  console.log("  ✅ run 없음 → no_completed_run 알림");

  // ---------- job별 감시(2026-10-03, 2026-10-05 회차 체계로 개편) ----------
  // 감시 대상: 엔터 오전·오후·저녁 + 사회. 수집일 경계는 KST 05:00이다.
  const JOB_NOW = new Date("2026-10-05T12:00:00Z"); // KST 10-05 21:00
  const kindRun = (
    kind: string | null,
    startedAt: string,
    id: number,
    round?: string,
    overrides: Partial<DiscoveryRunRow> = {}
  ) => makeRun(startedAt, { id, metadata: kind ? { kind, ...(round ? { round } : {}) } : null, ...overrides });

  const entMorning = kindRun("entertainment", "2026-10-05T00:01:00Z", 201, "morning"); // KST 09:01
  const entNoon = kindRun("entertainment", "2026-10-05T04:01:00Z", 202, "noon"); // KST 13:01
  const entEvening = kindRun("entertainment", "2026-10-05T09:01:00Z", 203, "evening"); // KST 18:01
  const social = kindRun("social_issue", "2026-10-05T11:01:00Z", 204); // KST 20:01
  const all = [social, entEvening, entNoon, entMorning];

  // 5) 네 job이 모두 이번 수집일에 돌았으면 ok, 발송 없음
  const okSends: string[] = [];
  const okResult = await runWatchdog({
    now: JOB_NOW,
    fetchRecent: async () => all,
    send: async (text) => {
      okSends.push(text);
    },
  });
  assert(okResult.verdict.ok && okResult.alerted === false && okSends.length === 0, "네 job이 다 돌았으면 알림 없음");
  assert(okResult.verdict.checks.length === 4, "감시 대상은 엔터 3회 + 사회 = 4개");
  console.log("  ✅ 엔터 3회 + 사회 모두 정상 → 발송 없음");

  // 6) 오후 회차만 빠졌다: 오전·저녁이 돌았다는 이유로 가려지면 안 된다(회차별로 본다).
  const noNoonSends: string[] = [];
  const noNoon = await runWatchdog({
    now: JOB_NOW,
    fetchRecent: async () => [social, entEvening, entMorning],
    send: async (text) => {
      noNoonSends.push(text);
    },
  });
  assert(!noNoon.verdict.ok && noNoon.alerted === true && noNoonSends.length === 1, "오후 회차만 빠져도 알려야 한다");
  assert(noNoon.verdict.failed.length === 1 && noNoon.verdict.failed[0].job.label === "엔터 오후(13시)", "안 돈 job은 엔터 오후 하나여야 한다");
  assert(noNoonSends[0].includes("❌ 엔터 오후(13시)") && noNoonSends[0].includes("✅ 엔터 오전(09시)"), "회차별 상태 줄이 보여야 한다");
  console.log("  ✅ 한 회차만 빠져도 그 회차 이름을 붙여 발송");

  // 7) 이전 사고 재현: 사회만 돌고 엔터는 며칠 전 run뿐이다.
  const oldEnt = kindRun("entertainment", "2026-10-02T10:00:00Z", 100, "evening");
  const incident = evaluateWatchdogByJob([social, oldEnt], JOB_NOW);
  assert(!incident.ok && incident.failed.length === 3, "엔터 3회 모두 stale이어야 한다");
  console.log("  ✅ 엔터가 통째로 안 돎 → 3회차 모두 감지");

  // 8) 실패했거나 진행 중인 run은 돌았다고 치지 않는다.
  const failedEnt = kindRun("entertainment", "2026-10-05T09:01:00Z", 203, "evening", { status: "failed" });
  const failedVerdict = evaluateWatchdogByJob([social, entNoon, entMorning, failedEnt], JOB_NOW);
  assert(!failedVerdict.ok && failedVerdict.failed.length === 1 && failedVerdict.failed[0].job.label === "엔터 저녁(18시)", "failed run은 돌았다고 치면 안 된다");
  console.log("  ✅ 실패한 run은 정상으로 안 침");

  // 9) kind(또는 round)가 없는 run이 누락을 가리면 안 된다.
  const anonymous = kindRun(null, "2026-10-05T10:30:00Z", 300);
  const noRound = kindRun("entertainment", "2026-10-05T10:40:00Z", 301); // round 없음 - 옛 형식
  const masked = evaluateWatchdogByJob([social, entMorning, entNoon, anonymous, noRound], JOB_NOW);
  assert(!masked.ok && masked.failed.length === 1 && masked.failed[0].job.label === "엔터 저녁(18시)", "kind/round 없는 run이 저녁 누락을 가리면 안 된다");
  console.log("  ✅ kind·round 없는 run은 어느 job으로도 안 침");

  // 10) 기록이 아예 없으면 전부 no_completed_run
  const none = evaluateWatchdogByJob([], JOB_NOW);
  assert(none.failed.length === 4 && none.checks.every((c) => !c.verdict.ok && c.verdict.reason === "no_completed_run"), "기록이 없으면 전부 실패여야 한다");
  console.log("  ✅ 기록 없음 → 네 job 모두 no_completed_run");

  // 11) 예약이 지연돼 자정을 넘겨 돌아도(02:42 KST) 전날 run은 같은 수집일이라 ok여야 한다. 실제 사고 값 기준.
  const delayed = new Date("2026-10-05T17:42:25Z"); // KST 10-06 02:42
  assert(evaluateWatchdogByJob(all, delayed).ok, "자정을 넘겨 돌아도 전날 run들은 같은 수집일이라 ok");
  console.log("  ✅ 지연으로 자정을 넘겨도 job별 판정이 ok");

  // 12) 발송이 던져도 runWatchdog는 예외를 밖으로 내보내지 않는다
  const failResult = await runWatchdog({
    now: JOB_NOW,
    fetchRecent: async () => [],
    send: async () => {
      throw new Error("network down");
    },
  });
  assert(failResult.alerted === false && failResult.sendError === "network down", "발송 실패는 sendError로만 알린다");
  console.log("  ✅ 발송 실패 → 예외 없이 sendError");

  // 13) 수집일 경계(KST 05:00). 09시 회차가 전날로 분류되면 안 되고, 04:59까지는 전날 수집일이다.
  assert(
    collectionDayString(new Date("2026-10-04T19:59:00Z")) === "2026-10-04" && // KST 10-05 04:59
      collectionDayString(new Date("2026-10-04T20:00:00Z")) === "2026-10-05", // KST 10-05 05:00
    "수집일은 KST 05:00에 바뀌어야 한다"
  );
  assert(
    collectionDayString(new Date("2026-10-05T00:01:00Z")) === collectionDayString(new Date("2026-10-05T11:01:00Z")),
    "09:01 KST 회차와 20:01 KST 사회가 같은 수집일이어야 한다"
  );
  console.log("  ✅ 수집일 경계 = KST 05:00, 09~20시 수집이 한 수집일");

  // 14) 진짜 누락은 정시·지연 모두 잡는다.
  const missed = evaluateWatchdog(makeRun("2026-10-04T09:01:00Z", { id: 102 }), JOB_NOW);
  assert(!missed.ok && missed.reason === "stale_run", "전날 run만 있으면 stale이어야 한다");
  const missedLate = evaluateWatchdog(makeRun("2026-10-04T09:01:00Z", { id: 102 }), delayed);
  assert(!missedLate.ok && missedLate.reason === "stale_run", "지연돼 돌아도 진짜 누락은 잡아야 한다");
  console.log("  ✅ 진짜 누락(정시·지연 모두) → stale_run");

  if (shouldActuallySend) {
    console.log("\n▶ SEND=1 - 실제 Telegram으로 stale 알림 발송");
    const real = await runWatchdog({
      now,
      fetchRecent: async () => [makeRun("2000-01-01T00:00:00Z", { id: 0, metadata: { kind: "social_issue" } })],
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
