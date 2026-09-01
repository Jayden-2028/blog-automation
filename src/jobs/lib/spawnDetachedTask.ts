// 오래 걸리는 파이프라인 단계(자료조사·집필, 각각 10~20분)를 폴러와 분리된 프로세스로 띄운다.
//
// 왜 필요한가: telegram-poll이 콜백 처리 안에서 runResearchStage/runWritingStage를 동기 실행하면,
// 그 15분 동안 singleInstanceLock 때문에 다음 폴링이 전부 건너뛰어진다 - 버튼을 눌러도 아무 반응이
// 없다. 무거운 단계를 detached child로 분리하면 폴러는 즉시(수 초) 끝나고, 다음 주기에 다른 버튼에
// 반응할 수 있다. 완료·실패 알림은 그 child(job:research / job:write CLI)가 직접 Telegram으로 보낸다.
//
// caffeinate로 감싸는 이유: 부모 폴러가 먼저 끝나면 폴러의 caffeinate assertion이 사라진다. child가
// 자기 assertion을 들고 있어야 그동안 맥이 잠들어 프로세스가 죽지 않는다(CURRENT_STATE "잠자기로
// 인한 조용한 실패" 참고).

import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { resolve } from "node:path";

function resolveNpm(): string {
  const fromEnv = process.env.npm_execpath ? null : process.env.NPM_BIN;
  if (fromEnv) return fromEnv;
  return ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"].find((p) => existsSync(p)) ?? "npm";
}

const CAFFEINATE = "/usr/bin/caffeinate";

/**
 * `npm run <script> -- <args>`를 detached·caffeinated 프로세스로 띄우고 즉시 반환한다.
 * 출력은 logs/<script>.detached.log로 append한다(실패 원인 추적용). 자식은 unref해 부모를 붙잡지 않는다.
 */
export function spawnDetachedTask(script: string, args: string[]): void {
  const logPath = resolve("logs", `${script.replace(/[^a-z0-9-]/gi, "_")}.detached.log`);
  let out = "ignore" as number | "ignore";
  try {
    out = openSync(logPath, "a");
  } catch {
    out = "ignore";
  }

  const npmBin = resolveNpm();
  const useCaffeinate = existsSync(CAFFEINATE);
  const cmd = useCaffeinate ? CAFFEINATE : npmBin;
  const cmdArgs = useCaffeinate
    ? ["-i", npmBin, "run", "--silent", script, "--", ...args]
    : ["run", "--silent", script, "--", ...args];

  const child = spawn(cmd, cmdArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
}
