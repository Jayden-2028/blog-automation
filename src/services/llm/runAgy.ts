// Antigravity CLI(`agy`) 헤드리스 호출 1회(2026-11-19). 사용자의 Google AI 구독 로그인으로 돈다 - API 키·요금이 없다.
//
// **로그인된 맥미니에서만 돈다**(GitHub Actions 불가). 헤드리스는 이전에 대화형으로 로그인해 캐시된 자격증명을
// 쓰고, 로그인이 없으면 "authentication required" 오류로 끝난다 - 그 경우 authRequired=true로 돌려준다.
// 공식 문서: https://antigravity.google/docs/cli/headless , /docs/cli/reference
//
// 호출 형태: `agy -p "<prompt>" --output-format json [--model X] --print-timeout 15m [AGY_EXTRA_ARGS...]`
//  - stdout에 JSON 봉투 하나: {conversation_id, status, response, duration_seconds, num_turns, usage{...}}, 진단은 stderr.
//  - **빈 임시 폴더에서 실행한다**(에이전트가 저장소를 건드리지 못하게). `--dangerously-skip-permissions`는 넘기지 않는다.
//  - 실행기(executor)는 주입할 수 있다 - 테스트는 실제 agy 없이 돈다.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractTrailingJson } from "./runHeadlessCodex.js";

export const AGY_CALL_TIMEOUT_MS = 15 * 60 * 1000;
/** agy 자체 타임아웃(`--print-timeout`)이 먼저 끝나게 하고, 우리 킬은 그보다 조금 늦게 건다. */
const KILL_GRACE_MS = 60 * 1000;

export type AgyExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };
export type AgyExecutor = (binary: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<AgyExecResult>;

export type RunAgyOptions = {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  binary?: string;
  executor?: AgyExecutor;
};

export type AgyUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
};

export type RunAgyResult =
  | { ok: true; text: string; model: string | null; usage: AgyUsage; durationMs: number; numTurns: number | null; conversationId: string | null }
  | { ok: false; error: string; authRequired: boolean; durationMs: number };

export const AGY_LOGIN_MESSAGE = "맥미니 agy 로그인 필요 - 맥미니 터미널에서 `agy`를 열어 구독 계정으로 로그인한 뒤 다시 실행하세요";

const AUTH_PATTERN = /authentication required|not (logged|signed) in|log ?in required|sign ?in required|unauthenticated|please (log|sign) ?in/i;

export function isAgyAuthError(...texts: string[]): boolean {
  return texts.some((text) => AUTH_PATTERN.test(text));
}

const defaultExecutor: AgyExecutor = (binary, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result: AgyExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => void (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, timedOut: false, spawnError: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut: false });
    });
  });

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 봉투 JSON -> 결과. 봉투가 아니거나 SUCCESS가 아니면 사유를 돌려준다. 순수 함수. */
export function parseAgyEnvelope(stdout: string, stderr = ""): Omit<Extract<RunAgyResult, { ok: true }>, "durationMs"> | { error: string; authRequired: boolean } {
  const data = extractTrailingJson(stdout) as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const auth = isAgyAuthError(stdout, stderr);
    return { error: auth ? AGY_LOGIN_MESSAGE : `agy 출력에서 JSON 봉투를 찾지 못했습니다: ${(stdout || stderr).trim().slice(-300)}`, authRequired: auth };
  }
  const response = typeof data.response === "string" ? data.response.trim() : "";
  const status = typeof data.status === "string" ? data.status : "";
  if (status !== "SUCCESS") {
    const auth = isAgyAuthError(response, stdout, stderr);
    return { error: auth ? AGY_LOGIN_MESSAGE : `agy 상태 ${status || "없음"}${response ? ` - ${response.slice(0, 300)}` : ""}`, authRequired: auth };
  }
  if (!response) return { error: "agy가 빈 응답을 돌려줬습니다", authRequired: false };
  const u = (data.usage && typeof data.usage === "object" ? data.usage : {}) as Record<string, unknown>;
  return {
    ok: true,
    text: response,
    model: typeof data.model === "string" ? data.model : null,
    usage: {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      thinkingTokens: num(u.thinking_tokens),
      cacheReadTokens: num(u.cache_read_tokens),
      totalTokens: num(u.total_tokens),
    },
    numTurns: num(data.num_turns),
    conversationId: typeof data.conversation_id === "string" ? data.conversation_id : null,
  };
}

export async function runAgy(options: RunAgyOptions): Promise<RunAgyResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? AGY_CALL_TIMEOUT_MS;
  const minutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
  const args = ["-p", options.prompt, "--output-format", "json", "--print-timeout", `${minutes}m`];
  if (options.model) args.push("--model", options.model);
  args.push(...(options.extraArgs ?? []));

  const cwd = await mkdtemp(join(tmpdir(), "agy-person-"));
  try {
    const run = await (options.executor ?? defaultExecutor)(options.binary ?? process.env.AGY_BIN ?? "agy", args, { cwd, timeoutMs: timeoutMs + KILL_GRACE_MS });
    const durationMs = Date.now() - startedAt;
    if (run.spawnError) {
      return { ok: false, error: `agy 실행 실패(PATH에 있나요?): ${run.spawnError}`, authRequired: false, durationMs };
    }
    if (run.timedOut) return { ok: false, error: `agy가 ${minutes}분 안에 끝나지 않아 중단했습니다`, authRequired: false, durationMs };

    const parsed = parseAgyEnvelope(run.stdout, run.stderr);
    if ("error" in parsed) {
      const detail = run.code !== 0 && !parsed.authRequired ? `${parsed.error} (종료 코드 ${run.code})` : parsed.error;
      return { ok: false, error: detail, authRequired: parsed.authRequired, durationMs };
    }
    return { ...parsed, durationMs };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
