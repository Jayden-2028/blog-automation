// acquireSingleInstanceLock 회귀 테스트. 실제 파일시스템만 쓰고 외부 의존성은 없다.
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireSingleInstanceLock } from "./singleInstanceLock.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
const lockPath = join(dir, "sub", "job.lock");

try {
  // 1) 첫 획득 성공 + PID 기록
  const first = acquireSingleInstanceLock(lockPath);
  assert(first, "첫 획득은 성공해야 한다");
  assert(existsSync(lockPath), "락 파일이 생겨야 한다");
  assert(readFileSync(lockPath, "utf8").trim() === String(process.pid), "락 파일에 현재 PID가 기록돼야 한다");
  console.log("✅ 첫 획득 -> 락 파일 생성 + PID 기록");

  // 2) 같은 프로세스가 다시 시도하면(=이전 실행이 아직 도는 상황 모사) null
  const second = acquireSingleInstanceLock(lockPath);
  assert(second === null, "이미 살아 있는 소유자가 있으면 null이어야 한다");
  console.log("✅ 살아 있는 소유자 있음 -> 두 번째 획득은 null");

  // 3) release 후 재획득 가능
  first!.release();
  assert(!existsSync(lockPath), "release 후 락 파일이 지워져야 한다");
  const third = acquireSingleInstanceLock(lockPath);
  assert(third, "release 후에는 다시 획득할 수 있어야 한다");
  third!.release();
  console.log("✅ release -> 락 해제 + 재획득 가능");

  // 4) 죽은 PID가 남긴 락은 stale로 보고 가로챈다
  writeFileSync(lockPath, "999999"); // 존재하지 않을 PID
  const afterDeadPid = acquireSingleInstanceLock(lockPath);
  assert(afterDeadPid, "죽은 PID가 남긴 락은 가로채야 한다");
  assert(readFileSync(lockPath, "utf8").trim() === String(process.pid), "가로챈 뒤 현재 PID로 갱신돼야 한다");
  afterDeadPid!.release();
  console.log("✅ 죽은 PID 락 -> stale로 가로챔");

  // 5) 오래된 락 파일(staleMs 초과)도 가로챈다 - PID가 살아 있어도.
  writeFileSync(lockPath, String(process.pid));
  const old = Date.now() / 1000 - 3600; // 1시간 전
  utimesSync(lockPath, old, old);
  const afterOld = acquireSingleInstanceLock(lockPath, { staleMs: 60_000 });
  assert(afterOld, "staleMs보다 오래된 락은 가로채야 한다");
  afterOld!.release();
  console.log("✅ staleMs 초과 락 -> 가로챔");

  console.log("\n✅ singleInstanceLock 테스트 완료");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
