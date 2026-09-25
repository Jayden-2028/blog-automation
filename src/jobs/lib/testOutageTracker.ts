// 멈춤 기록·복구 알림 테스트. 실행: npm run test:outage-tracker
//
// 지켜야 할 것: ① 첫 실패 시각을 유지하며 횟수만 늘린다 ② 복구하면 한 번만 알리고 기록을 지운다
// ③ 24시간(텔레그램 보관 한도)을 넘기면 유실 가능성을 말한다 ④ 멈춘 적 없으면 아무 말 안 한다
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeRecovery, recordFailure, takeRecovery } from "./outageTracker.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const dir = mkdtempSync(join(tmpdir(), "outage-"));
const path = join(dir, "state.json");

console.log("▶ 멈춤 기록 테스트 시작\n");

// 1) 멈춘 적이 없으면 알릴 것이 없다.
{
  assert(takeRecovery(path) === null, "기록이 없으면 null");
  console.log("✅ 멈춘 적 없으면 알리지 않는다");
}

// 2) 연속 실패 - 첫 시각은 유지하고 횟수만 는다.
{
  const t0 = new Date("2026-09-24T00:00:00Z");
  const a = recordFailure(path, "ENOTFOUND supabase.co", t0);
  const b = recordFailure(path, "ENOTFOUND supabase.co", new Date("2026-09-24T01:00:00Z"));
  assert(a.failures === 1 && b.failures === 2, `횟수가 늘어야 한다 (${b.failures})`);
  assert(b.firstFailedAt === a.firstFailedAt, "첫 실패 시각은 그대로여야 한다");
  console.log("✅ 연속 실패 - 첫 시각 유지, 횟수 증가");
}

// 3) 복구 - 멈춘 시간을 계산하고 기록을 지운다.
{
  const recovery = takeRecovery(path, new Date("2026-09-24T03:00:00Z"));
  assert(recovery !== null, "복구 내역이 나와야 한다");
  assert(recovery!.hours === 3, `3시간이어야 한다 (${recovery!.hours})`);
  assert(recovery!.failures === 2, "실패 횟수가 실려야 한다");
  assert(!recovery!.mayHaveLostUpdates, "3시간은 보관 한도 안이다");
  assert(takeRecovery(path) === null, "한 번 알린 뒤에는 기록이 없어야 한다");
  console.log("✅ 복구 - 시간 계산 + 기록 삭제(중복 알림 없음)");
}

// 4) 24시간을 넘기면 유실 가능성을 말한다. 실측이 39시간이었다.
{
  recordFailure(path, "ENOTFOUND", new Date("2026-09-24T07:00:00Z"));
  const recovery = takeRecovery(path, new Date("2026-09-25T22:00:00Z"));
  assert(recovery!.hours === 39, `39시간이어야 한다 (${recovery!.hours})`);
  assert(recovery!.mayHaveLostUpdates, "24시간을 넘겼으면 유실 가능성을 표시해야 한다");

  const text = describeRecovery(recovery!, "인스타 링크 수신");
  assert(text.includes("39시간 멈춰"), "멈춘 시간을 말해야 한다");
  assert(text.includes("사라졌을 수 있습니다"), "유실 가능성을 말해야 한다");
  assert(text.includes("다시 보내주세요"), "사람이 할 일을 말해야 한다");
  console.log("✅ 24시간 초과 - 유실 가능성과 할 일을 알린다");
}

// 5) 짧은 멈춤은 담담하게. 매번 경고하면 사람이 무시하게 된다.
{
  recordFailure(path, "timeout", new Date("2026-09-25T10:00:00Z"));
  const recovery = takeRecovery(path, new Date("2026-09-25T12:00:00Z"));
  const text = describeRecovery(recovery!, "인스타 링크 수신");
  assert(text.includes("복구됐습니다"), "짧은 멈춤은 복구 알림이다");
  assert(!text.includes("사라졌을 수 있습니다"), "유실 경고를 붙이면 안 된다");
  console.log("✅ 짧은 멈춤은 경고하지 않는다");
}

rmSync(dir, { recursive: true, force: true });
console.log("\n🎉 멈춤 기록 테스트 통과");
