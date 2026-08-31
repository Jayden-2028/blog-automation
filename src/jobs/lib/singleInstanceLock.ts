// launchd가 주기적으로 띄우는 job이 이전 실행과 겹치지 않게 하는 파일 락.
//
// 왜 필요한가(2026-08-31): telegram-poll은 5분 주기인데, Go 콜백이 자료조사(최대 3분)를,
// 원고 작성 버튼이 집필(최대 5분)을 콜백 처리 안에서 동기 실행한다. 한 번 실행이 5분을 넘기면
// 다음 launchd 발화가 겹쳐 뜨고, 두 프로세스가 같은 getUpdates offset을 읽어 같은 클릭을 두 번
// 처리할 수 있다. offset은 처리 완료 후에만 커밋되므로, 락으로 동시 실행만 막으면 중복이 없다.
//
// stale 판정: 락을 잡은 PID가 죽었거나(process.kill(pid,0) 실패) 락 파일이 staleMs보다 오래되면
// 이전 실행이 강제 종료된 것으로 보고 락을 가로챈다 - 안 그러면 한 번 죽은 뒤 영영 안 뜬다.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SingleInstanceLock = { release: () => void };

export type AcquireLockOptions = {
  /** 이 시간(ms)보다 오래된 락 파일은 강제 종료 잔재로 보고 가로챈다. 기본 15분. */
  staleMs?: number;
};

/**
 * 락을 잡으면 { release } 를 반환하고, 이미 다른 인스턴스가 돌고 있으면 null을 반환한다.
 * 호출부는 null이면 조용히 종료한다(launchd가 다음 주기에 다시 시도한다).
 */
export function acquireSingleInstanceLock(
  lockPath: string,
  options: AcquireLockOptions = {}
): SingleInstanceLock | null {
  const staleMs = options.staleMs ?? 15 * 60 * 1000;
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    if (!isStale(lockPath, staleMs)) return null;
    // stale - 이전 실행 잔재. 지우고 새로 잡는다.
    try {
      rmSync(lockPath, { force: true });
    } catch {
      return null;
    }
  }

  try {
    // wx: 이미 있으면 실패한다(그 사이 다른 프로세스가 잡은 경우).
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch {
    return null;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const owner = readFileSync(lockPath, "utf8").trim();
      if (owner === String(process.pid)) rmSync(lockPath, { force: true });
    } catch {
      // 이미 지워졌거나 다른 프로세스가 가져감 - 무시.
    }
  };

  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return { release };
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) return true;

    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return true;

    try {
      process.kill(pid, 0); // 살아 있으면 아무 일도 안 일어난다.
      return false;
    } catch (error) {
      // ESRCH: 그런 프로세스 없음 -> stale. EPERM: 살아 있지만 신호 권한 없음 -> stale 아님.
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return true; // 락 파일을 읽을 수 없으면 없는 것으로 취급.
  }
}
