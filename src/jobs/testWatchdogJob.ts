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

  // ---------- job별 감시(2026-10-03) ----------
  // 사고 재현: 10-01·10-02에 엔터·커뮤니티가 통째로 안 돌았는데 사회·경제가 돌았다는 이유로
  // 정상 판정이었다. 감시 대상 3개 job을 각각 본다.
  const JOB_NOW = new Date("2026-10-02T12:00:00Z"); // KST 10-02 21:00
  const kindRun = (kind: string | null, startedAt: string, id: number, overrides: Partial<DiscoveryRunRow> = {}) =>
    makeRun(startedAt, { id, metadata: kind ? { kind } : null, ...overrides });

  const social = kindRun("social_issue", "2026-10-02T09:00:00Z", 103); // KST 18:00
  const ent = kindRun("entertainment", "2026-10-02T10:00:00Z", 104); // KST 19:00
  const comm = kindRun("community", "2026-10-02T11:00:00Z", 105); // KST 20:00

  // 5) 세 job이 모두 이번 수집일에 돌았으면 ok, 발송 없음
  const okSends: string[] = [];
  const okResult = await runWatchdog({
    now: JOB_NOW,
    fetchRecent: async () => [comm, ent, social],
    send: async (text) => {
      okSends.push(text);
    },
  });
  assert(okResult.verdict.ok && okResult.alerted === false && okSends.length === 0, "세 job이 다 돌았으면 알림 없음");
  console.log("  ✅ 세 job 모두 정상 → 발송 없음");

  // 6) 이틀 사고 그대로: 사회·경제만 돌고 엔터·커뮤니티는 마지막 run이 3일 전이다.
  const oldEnt = kindRun("entertainment", "2026-09-30T03:01:00Z", 100);
  const oldComm = kindRun("community", "2026-09-30T09:01:00Z", 101);
  const incidentSends: string[] = [];
  const incident = await runWatchdog({
    now: JOB_NOW,
    fetchRecent: async () => [social, oldComm, oldEnt],
    send: async (text) => {
      incidentSends.push(text);
    },
  });
  assert(!incident.verdict.ok && incident.alerted === true && incidentSends.length === 1, "일부 job만 안 돌아도 알려야 한다 (이전 판정은 이걸 놓쳤다)");
  assert(
    incident.verdict.failed.map((c) => c.job.kind).sort().join() === "community,entertainment",
    "안 돈 job은 엔터·커뮤니티 두 개여야 한다"
  );
  const msg = incidentSends[0];
  assert(msg.includes("엔터·OTT") && msg.includes("커뮤니티"), "알림에 안 돈 job 이름이 있어야 한다");
  assert(msg.includes("❌ 엔터·OTT") && msg.includes("❌ 커뮤니티") && msg.includes("✅ 사회·경제"), "job별 상태 줄이 보여야 한다");
  assert(msg.includes("run #100") && msg.includes("run #101"), "각 job의 마지막 run 번호가 보여야 한다");
  console.log("  ✅ 일부 job만 안 돎(실제 사고 재현) → 안 돈 job 이름을 붙여 발송 1회");

  // 7) 옛 판정이 못 보던 경우: 하나의 job만 빠져도 잡는다.
  const onlyComm = evaluateWatchdogByJob([social, ent, oldComm], JOB_NOW);
  assert(!onlyComm.ok && onlyComm.failed.length === 1 && onlyComm.failed[0].job.kind === "community", "커뮤니티만 빠져도 잡아야 한다");
  console.log("  ✅ job 하나만 빠져도 감지");

  // 8) 실패했거나 진행 중인 run은 돌았다고 치지 않는다.
  const failedEnt = kindRun("entertainment", "2026-10-02T10:00:00Z", 104, { status: "failed" });
  const failedVerdict = evaluateWatchdogByJob([social, comm, failedEnt], JOB_NOW);
  assert(!failedVerdict.ok && failedVerdict.failed[0].job.kind === "entertainment", "failed run은 돌았다고 치면 안 된다");
  console.log("  ✅ 실패한 run은 정상으로 안 침");

  // 9) kind가 없는 run(옛 run·수동 실행)이 다른 job의 누락을 가리면 안 된다.
  const anonymous = kindRun(null, "2026-10-02T10:30:00Z", 200);
  const masked = evaluateWatchdogByJob([social, comm, anonymous], JOB_NOW);
  assert(!masked.ok && masked.failed[0].job.kind === "entertainment", "kind 없는 run이 엔터 누락을 가리면 안 된다");
  console.log("  ✅ kind 없는 run은 어느 job으로도 안 침");

  // 10) 기록이 아예 없으면 세 job 모두 no_completed_run
  const none = evaluateWatchdogByJob([], JOB_NOW);
  assert(none.failed.length === 3 && none.checks.every((c) => !c.verdict.ok && c.verdict.reason === "no_completed_run"), "기록이 없으면 전부 실패여야 한다");
  console.log("  ✅ 기록 없음 → 세 job 모두 no_completed_run");

  // 11) 예약이 지연돼 자정을 넘겨 돌아도(02:42 KST) 전날 저녁 run 셋은 ok여야 한다. 실제 사고 값이다.
  const delayed = new Date("2026-10-01T17:42:25Z"); // KST 10-02 02:42
  const prevEvening = [
    kindRun("social_issue", "2026-10-01T09:01:00Z", 102),
    kindRun("entertainment", "2026-10-01T10:01:00Z", 103),
    kindRun("community", "2026-10-01T11:01:00Z", 104),
  ];
  assert(evaluateWatchdogByJob(prevEvening, delayed).ok, "지연돼 자정을 넘겨 돌아도 전날 저녁 run은 같은 수집일이라 ok");
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

  // 13) 수집일 경계(2026-10-02 사고). 21:00 KST 예약이 GitHub schedule 지연으로 02:42 KST에
  //    돌았을 때 거짓 실패 알림이 나갔다. 실제 값 그대로 재현한다.
  const lateNow = new Date("2026-10-01T17:42:25Z"); // KST 2026-10-02 02:42
  const eveningRun = makeRun("2026-10-01T09:01:00Z", { id: 102 }); // KST 2026-10-01 18:01
  assert(
    evaluateWatchdog(eveningRun, lateNow).ok,
    "21시 예약이 자정을 넘겨 돌아도 전날 저녁 run은 같은 수집일이라 ok여야 한다 (실제 사고 재현)"
  );
  console.log("  ✅ 지연으로 자정을 넘겨 돌아도 전날 저녁 run → ok");

  // 14) 11시간 밀려도(= 다음 날 08:00 KST) 같은 수집일이다.
  const veryLate = new Date("2026-10-02T23:00:00Z"); // KST 2026-10-03 08:00
  assert(
    evaluateWatchdog(makeRun("2026-10-02T09:01:00Z"), veryLate).ok,
    "11시간 밀려도 같은 수집일이어야 한다"
  );
  console.log("  ✅ 11시간 지연에도 ok");

  // 15) 진짜 누락은 여전히 잡는다: 그날 저녁 run이 없고 어제 run만 있는 경우.
  const missed = evaluateWatchdog(makeRun("2026-10-01T09:01:00Z", { id: 102 }), new Date("2026-10-02T12:00:00Z"));
  assert(!missed.ok && missed.reason === "stale_run", "그날 저녁 run이 없으면 정시에 돌아도 stale이어야 한다");
  const missedLate = evaluateWatchdog(makeRun("2026-10-01T09:01:00Z", { id: 102 }), new Date("2026-10-02T17:42:25Z"));
  assert(!missedLate.ok && missedLate.reason === "stale_run", "지연돼 돌아도 진짜 누락은 잡아야 한다");
  console.log("  ✅ 진짜 누락(정시·지연 모두) → stale_run");

  // 16) 경계 자체: 정오 직전/직후에 수집일이 바뀐다.
  assert(
    collectionDayString(new Date("2026-10-02T02:59:00Z")) === "2026-10-01" && // KST 11:59
      collectionDayString(new Date("2026-10-02T03:00:00Z")) === "2026-10-02", // KST 12:00
    "수집일은 KST 정오에 바뀌어야 한다"
  );
  console.log("  ✅ 수집일 경계 = KST 12:00");

  if (shouldActuallySend) {
    console.log("\n▶ SEND=1 - 실제 Telegram으로 stale 알림 발송");
    const real = await runWatchdog({
      now,
      fetchRecent: async () => [makeRun("2000-01-01T00:00:00Z", { id: 0, metadata: { kind: "community" } })],
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
