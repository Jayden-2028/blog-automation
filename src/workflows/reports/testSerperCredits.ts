// Serper 크레딧 계산·경보 테스트. 순수 함수 + watchdog 주입(외부 호출 없음).

import { buildCostSummary } from "./buildCostSummary.js";
import {
  addMonths,
  computeSerperCredits,
  evaluateSerperCredits,
  formatSerperCreditAlert,
  readSerperCreditsConfig,
} from "./serperCredits.js";
import type { SerperUsageRow } from "./serperCredits.js";
import { runWatchdog } from "../../jobs/watchdogJob.js";
import type { DiscoveryRunRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const config = { purchased: 50000, purchasedAt: "2026-10-06" };

function rowsPerDay(now: Date, perDay: number, days: number, operation = "image.search"): SerperUsageRow[] {
  const rows: SerperUsageRow[] = [];
  for (let d = 0; d < days; d += 1) {
    const at = new Date(now.getTime() - d * 86_400_000 - 3_600_000).toISOString();
    rows.push({ provider: "serper", operation, quantity: 1, occurred_at: at });
  }
  // perDay행을 하루치로 늘리기보다 quantity로 압축한다.
  return rows.map((row) => ({ ...row, quantity: perDay }));
}

async function main(): Promise<void> {
  console.log("▶ Serper 크레딧 테스트 시작\n");

  // 환경값
  assert(readSerperCreditsConfig({ SERPER_CREDITS_PURCHASED: "50000", SERPER_CREDITS_PURCHASED_AT: "2026-10-06" } as NodeJS.ProcessEnv)?.purchased === 50000, "환경값 파싱");
  assert(readSerperCreditsConfig({} as NodeJS.ProcessEnv) === null, "없으면 null");
  assert(readSerperCreditsConfig({ SERPER_CREDITS_PURCHASED: "50000", SERPER_CREDITS_PURCHASED_AT: "어제" } as NodeJS.ProcessEnv) === null, "잘못된 날짜는 null");
  assert(addMonths("2026-10-06", 6) === "2027-04-06", "만료 = 구매 +6개월");
  assert(addMonths("2026-08-31", 6) === "2027-02-28", "말일 보정");
  console.log("  ✅ 환경값·만료일");

  // 구매 직후(소진 0) - 경보 없음, runway null
  const t0 = new Date("2026-10-06T03:00:00Z"); // KST 12:00, 구매 당일
  const fresh = computeSerperCredits({ config, usedEst: 0, recentRows: [], now: t0 });
  assert(fresh.remainingEst === 50000 && fresh.remainingPct === 100 && fresh.runwayDays === null, "구매 직후");
  assert(evaluateSerperCredits(fresh).length === 0, "구매 직후엔 경보 없음");
  console.log("  ✅ 구매 직후");

  // 하루 300 소진 × 10일 → 사용 3000, 잔여 47000, runway 156일 → 경보 없음
  const t10 = new Date("2026-10-16T03:00:00Z");
  const normal = computeSerperCredits({ config, usedEst: 3000, recentRows: rowsPerDay(t10, 300, 7), now: t10 });
  assert(normal.remainingEst === 47000 && normal.runwayDays === Math.floor(47000 / 300), `runway ${normal.runwayDays}`);
  assert(evaluateSerperCredits(normal).length === 0, "정상 속도엔 경보 없음");
  console.log("  ✅ 정상 소진");

  // 잔여 5,000 미만
  const low = computeSerperCredits({ config, usedEst: 46000, recentRows: [], now: new Date("2027-01-10T00:00:00Z") });
  const lowAlerts = evaluateSerperCredits(low);
  assert(lowAlerts.some((a) => a.kind === "low_credits"), "잔여 4,000 → low_credits");
  console.log("  ✅ 잔여 5,000 미만 경보");

  // 30일치 미만: 잔여 20000, 하루 1000
  const t = new Date("2026-12-01T03:00:00Z");
  const fast = computeSerperCredits({ config, usedEst: 30000, recentRows: rowsPerDay(t, 1000, 7), now: t });
  assert(fast.runwayDays === 20, `runway 20일 (${fast.runwayDays})`);
  const fastAlerts = evaluateSerperCredits(fast);
  assert(fastAlerts.length === 1 && fastAlerts[0].kind === "low_runway", "30일 미만 → low_runway만");
  console.log("  ✅ 30일치 미만 경보");

  // 구매 4일 차에 하루 300: 7로 나누지 않고 경과일(4)로 나눔(과소평가 방지)
  const t4 = new Date("2026-10-10T03:00:00Z");
  const early = computeSerperCredits({
    config,
    usedEst: 1200,
    recentRows: [{ provider: "serper", operation: "image.search", quantity: 1200, occurred_at: "2026-10-08T00:00:00Z" }],
    now: t4,
  });
  assert(early.runwayDays === Math.floor(48800 / (1200 / 4.5)) && early.runwayDays < Math.floor(48800 / (1200 / 7)), `초반 runway는 경과일(4.5일)로 나눈다 (${early.runwayDays})`);
  console.log("  ✅ 초반 평균은 경과일 기준");

  // 실패 행은 소진으로 안 센다
  const withFailed = computeSerperCredits({
    config, usedEst: 100, now: t10,
    recentRows: [...rowsPerDay(t10, 100, 7), ...rowsPerDay(t10, 9999, 7, "image.search.failed")],
  });
  assert(withFailed.runwayDays === Math.floor(49900 / 100), "실패 행은 평균에서 제외");
  console.log("  ✅ 실패 행 제외");

  // 유효기간: 150일 + 잔여 40% 이상
  const d150 = new Date("2027-03-06T03:00:00Z");
  const expiry = computeSerperCredits({ config, usedEst: 25000, recentRows: [], now: d150 });
  assert(expiry.daysSincePurchase >= 150 && evaluateSerperCredits(expiry).some((a) => a.kind === "expiry_risk"), "150일·잔여 50% → expiry_risk");
  const used = computeSerperCredits({ config, usedEst: 40000, recentRows: [], now: d150 });
  assert(!evaluateSerperCredits(used).some((a) => a.kind === "expiry_risk"), "잔여 20%면 만료 경보 없음");
  const early149 = computeSerperCredits({ config, usedEst: 25000, recentRows: [], now: new Date("2027-03-04T03:00:00Z") });
  assert(!evaluateSerperCredits(early149).some((a) => a.kind === "expiry_risk"), "149일차는 아직");
  console.log("  ✅ 만료 임박 경보");

  // cost.json 블록 + 이중 계상 방지(fixed에 serper 없음)
  const summary = buildCostSummary({ rows: [], fixedCosts: [], serperCredits: normal, now: t10 });
  assert(summary.serperCredits?.purchased === 50000 && summary.serperCredits.expiresAt === "2027-04-06", "cost.json serperCredits");
  assert(summary.notes.some((n) => n.includes("크레딧 게이지")), "게이지 안내 note");
  assert(buildCostSummary({ rows: [], fixedCosts: [], now: t10 }).serperCredits === null, "환경값 없으면 null");
  console.log("  ✅ cost.json 블록");

  // watchdog: 경고 발송 / 정상이면 무발송 / 환경값 없으면 생략 / job 판정과 독립
  const sent: string[] = [];
  const okRuns = [
    ["morning"], ["noon"], ["evening"],
  ].map(([round], i) => ({
    id: i + 1, started_at: "2026-12-01T00:05:00Z", completed_at: "2026-12-01T00:10:00Z", status: "completed",
    candidates_count: 1, clusters_count: 1, inserted_count: 1, error_count: 0, source: "naver", seed_queries: null,
    metadata: { kind: "entertainment", round }, created_at: "2026-12-01T00:05:00Z",
  })).concat([{
    id: 9, started_at: "2026-12-01T00:05:00Z", completed_at: "2026-12-01T00:10:00Z", status: "completed",
    candidates_count: 1, clusters_count: 1, inserted_count: 1, error_count: 0, source: "naver", seed_queries: null,
    metadata: { kind: "social_issue", round: undefined as unknown as string }, created_at: "2026-12-01T00:05:00Z",
  }, {
    id: 10, started_at: "2026-12-01T00:05:00Z", completed_at: "2026-12-01T00:10:00Z", status: "completed",
    candidates_count: 1, clusters_count: 1, inserted_count: 1, error_count: 0, source: "naver", seed_queries: null,
    metadata: { kind: "kscene_topic" }, created_at: "2026-12-01T00:05:00Z",
  }]) as unknown as DiscoveryRunRow[];
  const now = new Date("2026-12-01T03:00:00Z");

  const alerted = await runWatchdog({ now, fetchRecent: async () => okRuns, send: async (m) => void sent.push(m), fetchSerperCredits: async () => fast });
  assert(alerted.verdict.ok, "job은 정상");
  assert(alerted.serper?.alerted === true && sent.length === 1 && sent[0].includes("Serper") && sent[0].includes("20일"), "크레딧 경고 발송");
  assert(sent[0] === formatSerperCreditAlert(fast, evaluateSerperCredits(fast)), "본문 일치");

  sent.length = 0;
  const quiet = await runWatchdog({ now, fetchRecent: async () => okRuns, send: async (m) => void sent.push(m), fetchSerperCredits: async () => normal });
  assert(quiet.serper?.alerted === false && sent.length === 0, "정상이면 발송 없음");

  const skipped = await runWatchdog({ now, fetchRecent: async () => okRuns, send: async (m) => void sent.push(m), fetchSerperCredits: async () => null });
  assert(skipped.serper === undefined && sent.length === 0, "환경값 없으면 검사 생략");

  const broken = await runWatchdog({ now, fetchRecent: async () => okRuns, send: async () => {}, fetchSerperCredits: async () => { throw new Error("db"); } });
  assert(broken.verdict.ok && broken.serper === undefined, "크레딧 점검 실패가 job 감시를 막지 않는다");

  const dry = await runWatchdog({ now, dryRun: true, fetchRecent: async () => okRuns, send: async (m) => void sent.push(m), fetchSerperCredits: async () => fast });
  assert(dry.serper?.alerted === false && dry.serper.message && sent.length === 0, "dry-run은 발송 안 함");
  console.log("  ✅ watchdog 경고 로직");

  console.log("\n✅ Serper 크레딧 테스트 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
