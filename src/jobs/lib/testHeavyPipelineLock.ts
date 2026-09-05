// runWithHeavyPipelineLock 회귀 테스트. 실제 파일시스템만 쓰고 외부 의존성은 없다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithHeavyPipelineLock } from "./heavyPipelineLock.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "heavy-lock-test-"));
  const lockPath = join(dir, "sub", "heavy.lock");

  try {
    // 1) 겹치는 두 호출은 직렬화된다 - 동시에 실행되면 안 된다.
    const order: string[] = [];
    let running = 0;
    let sawOverlap = false;

    const task = (name: string, workMs: number) =>
      runWithHeavyPipelineLock(
        async () => {
          running += 1;
          if (running > 1) sawOverlap = true;
          order.push(`${name}:start`);
          await sleep(workMs);
          order.push(`${name}:end`);
          running -= 1;
        },
        { lockPath, pollIntervalMs: 20 }
      );

    await Promise.all([task("A", 80), task("B", 20)]);

    assert(!sawOverlap, "두 작업이 동시에 실행되면 안 된다");
    assert(
      order.join(",") === "A:start,A:end,B:start,B:end" || order.join(",") === "B:start,B:end,A:start,A:end",
      `한쪽이 완전히 끝난 뒤에만 다음이 시작해야 한다 (실제: ${order.join(",")})`
    );
    console.log("✅ 동시 호출 -> 직렬화(겹침 없음)");

    // 2) 락을 오래 못 잡으면(maxWaitMs 초과) 대기를 포기하고 그냥 실행한다.
    const blocker = runWithHeavyPipelineLock(() => sleep(200), { lockPath, pollIntervalMs: 20 });
    const startedAt = Date.now();
    let ranWithoutLock = false;
    await runWithHeavyPipelineLock(
      async () => {
        ranWithoutLock = true;
      },
      { lockPath, pollIntervalMs: 20, maxWaitMs: 50 }
    );
    assert(ranWithoutLock, "maxWaitMs를 넘기면 락 없이도 fn을 실행해야 한다");
    assert(Date.now() - startedAt < 200, "maxWaitMs 초과 후에는 blocker를 기다리지 않고 바로 실행해야 한다");
    await blocker;
    console.log("✅ maxWaitMs 초과 -> 대기 포기하고 실행");

    // 3) fn이 실패해도 락은 반드시 풀린다(다음 호출이 영원히 못 잡으면 안 된다).
    await runWithHeavyPipelineLock(
      async () => {
        throw new Error("의도된 실패");
      },
      { lockPath, pollIntervalMs: 20 }
    ).catch(() => {});

    const afterFailureStartedAt = Date.now();
    let secondRan = false;
    await runWithHeavyPipelineLock(
      async () => {
        secondRan = true;
      },
      { lockPath, pollIntervalMs: 20, maxWaitMs: 5_000 }
    );
    assert(secondRan, "실패한 fn 뒤에도 락이 풀려 다음 호출이 실행돼야 한다");
    assert(Date.now() - afterFailureStartedAt < 1_000, "락이 즉시 풀렸다면 대기 없이 바로 실행돼야 한다");
    console.log("✅ fn 실패 -> 락 해제 보장");

    console.log("\n✅ heavyPipelineLock 테스트 완료");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
