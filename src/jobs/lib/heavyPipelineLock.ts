// 조사(researcher)·집필(writer) 헤드리스 실행을 프로세스 전체에서 1개로 직렬화한다.
//
// 왜 필요한가(2026-09-05 실측): Go 버튼을 연달아 여러 개 누르면 job:research detached 프로세스가
// 동시에 여러 개 뜬다(spawnDetachedTask.ts). singleInstanceLock은 telegram-poll 폴러 자체에만
// 걸려 있어 이 detached 프로세스들끼리는 서로 막지 않는다 - 그 결과 헤비(WebSearch 다회 호출)
// 헤드리스 세션 3개가 동시에 같은 계정 리소스를 나눠 쓰면서 개별 조사가 18분 타임아웃을 넘겨
// 3건 전부 실패했다.
//
// 완전한 대기열(큐) 대신 재시도 락으로 최소 구현한다: 이미 다른 조사/집필이 돌고 있으면 짧은
// 간격으로 재시도하며 기다리다가, 잡으면 실행하고 끝나면 즉시 놓는다. 최대 대기 시간을 넘기면
// 포기하고 그냥 실행한다 - 대기로 job이 영원히 멈추는 것보다는 경합을 감수하는 게 낫다.

import { acquireSingleInstanceLock } from "./singleInstanceLock.js";

const LOCK_PATH = "logs/.pipeline-heavy.lock";
const POLL_INTERVAL_MS = 10_000;
/** 조사(18분)·집필(20분) 중 가장 긴 것보다 넉넉히 길게 - 정상 실행 중인 락을 stale로 가로채면 안 된다. */
const STALE_MS = 30 * 60 * 1000;
/** 앞서 대기 중인 job까지 순서대로 끝나길 기다릴 수 있는 상한. 이보다 오래 못 잡으면 경합을 감수하고 실행한다. */
const MAX_WAIT_MS = 50 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RunWithHeavyPipelineLockOptions = {
  lockPath?: string;
  pollIntervalMs?: number;
  staleMs?: number;
  maxWaitMs?: number;
};

/**
 * fn을 실행하기 전에 전역 락을 잡는다. 이미 잡혀 있으면 pollIntervalMs 간격으로 재시도하고,
 * maxWaitMs를 넘기면 포기하고 그냥 fn을 실행한다(락 없이). fn이 끝나면(성공/실패 무관) 잡았던
 * 락을 놓는다.
 */
export async function runWithHeavyPipelineLock<T>(
  fn: () => Promise<T>,
  options: RunWithHeavyPipelineLockOptions = {}
): Promise<T> {
  const lockPath = options.lockPath ?? LOCK_PATH;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;

  const startedAt = Date.now();
  let lock = acquireSingleInstanceLock(lockPath, { staleMs });
  while (!lock) {
    if (Date.now() - startedAt > maxWaitMs) {
      console.warn(`⚠️ [heavy-lock] ${maxWaitMs}ms 대기해도 락을 못 잡아 그냥 실행합니다(경합 감수).`);
      break;
    }
    await sleep(pollIntervalMs);
    lock = acquireSingleInstanceLock(lockPath, { staleMs });
  }

  try {
    return await fn();
  } finally {
    lock?.release();
  }
}
