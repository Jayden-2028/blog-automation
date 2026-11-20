// Codex CLI를 **쓰기 가능한 작업장**에서 1회 돌린다(2026-11-21, scenepick). runHeadlessCodex(읽기 전용 + JSON 스키마)와 다른 점:
//   - `--sandbox workspace-write --cd <작업장>`: Codex가 원고·meta.json·이미지 파일을 **직접 저장**한다(납품물이 파일이다).
//   - `--skip-git-repo-check`: 작업장은 git 저장소가 아니다(저장소 밖의 독립 폴더 - 우리 저장소를 건드리지 못하게).
//   - `-c tools.web_search=true`: 조사용 웹 검색(서버 쪽 도구라 샌드박스 네트워크 권한과 무관하다).
//   - 출력 스키마 없음: 결과는 stdout이 아니라 납품 폴더의 파일이고, 우리 쪽 형식 검사가 판정한다.
//   - 상한 40분: 조사 + 원고 + 이미지 4~8장 생성을 한 번에 한다(맥미니 실측 15~30분).
// 프롬프트는 stdin(`-`)으로 넣는다 - 인자로 넣으면 따옴표·길이 문제가 생긴다.
//
// **맥미니에서만 돈다** - Codex CLI와 ChatGPT 구독 로그인(~/.codex/auth.json)이 맥미니에만 있다. 로그인이 풀리면 authRequired=true.
// 실행기(executor)는 주입할 수 있다 - 테스트는 실제 codex 없이 돈다.
import { spawn } from "node:child_process";

import { resolveCodexBinary } from "./runHeadlessCodex.js";

export const CODEX_WORKSPACE_TIMEOUT_MS = 40 * 60 * 1000;

export const CODEX_LOGIN_MESSAGE = "맥미니 codex 로그인 필요 - 맥미니 터미널에서 `codex login`으로 ChatGPT 계정에 로그인한 뒤 다시 보내 주세요";

export type CodexExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };
export type CodexExecutor = (
  binary: string,
  args: string[],
  options: { cwd: string; stdin: string; timeoutMs: number }
) => Promise<CodexExecResult>;

export type RunCodexWorkspaceOptions = {
  prompt: string;
  /** 작업장 절대 경로. Codex가 쓸 수 있는 곳은 여기뿐이다(workspace-write). */
  workspace: string;
  timeoutMs?: number;
  binary?: string;
  executor?: CodexExecutor;
};

export type RunCodexWorkspaceResult =
  | { ok: true; durationMs: number; tokensUsed: number | null; stdoutTail: string }
  | { ok: false; error: string; authRequired: boolean; durationMs: number; tokensUsed: number | null; stdoutTail: string };

// 로그인 문제를 가리키는 문구. stdout 본문(에이전트가 읽은 웹 페이지 요약 등)에도 "unauthorized" 같은 말이 섞일 수 있어
// **실패했을 때만, stderr와 stdout 끝부분만** 본다(오탐으로 멀쩡한 실패를 "로그인 필요"로 부르지 않게).
const AUTH_PATTERN =
  /not logged in|codex login|please (log|sign) ?in|log ?in required|sign ?in required|401 unauthorized|unauthorized: |authentication (required|failed)|refresh token|token (has )?expired|re-?authenticate/i;

export function isCodexAuthError(...texts: string[]): boolean {
  return texts.some((text) => AUTH_PATTERN.test(text));
}

/** `tokens used` 합계(마지막 값). codex exec는 끝에 "tokens used\n12,345" 꼴로 찍는다 - 형식이 흔들려도 숫자만 읽는다. */
export function parseCodexTokensUsed(...texts: string[]): number | null {
  let last: number | null = null;
  for (const text of texts) {
    for (const match of text.matchAll(/tokens used[:\s]*([\d,]+)/gi)) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value)) last = value;
    }
  }
  return last;
}

export function buildCodexWorkspaceArgs(workspace: string): string[] {
  return ["exec", "--sandbox", "workspace-write", "--cd", workspace, "--skip-git-repo-check", "-c", "tools.web_search=true", "-"];
}

const defaultExecutor: CodexExecutor = (binary, args, { cwd, stdin, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result: CodexExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.on("error", () => {});
    child.stdin.write(stdin);
    child.stdin.end();
  });

export async function runCodexWorkspace(options: RunCodexWorkspaceOptions): Promise<RunCodexWorkspaceResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? CODEX_WORKSPACE_TIMEOUT_MS;
  const binary = options.binary ?? resolveCodexBinary();
  const run = await (options.executor ?? defaultExecutor)(binary, buildCodexWorkspaceArgs(options.workspace), {
    cwd: options.workspace,
    stdin: options.prompt,
    timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const tokensUsed = parseCodexTokensUsed(run.stdout, run.stderr);
  const stdoutTail = run.stdout.slice(-2000);

  if (run.spawnError) {
    return { ok: false, error: `codex 실행 실패(${binary} - CODEX_CLI_PATH 또는 PATH 확인): ${run.spawnError}`, authRequired: false, durationMs, tokensUsed, stdoutTail };
  }
  if (run.timedOut) {
    return { ok: false, error: `codex가 ${Math.round(timeoutMs / 60_000)}분 안에 끝나지 않아 중단했습니다`, authRequired: false, durationMs, tokensUsed, stdoutTail };
  }
  if (run.code !== 0) {
    const auth = isCodexAuthError(run.stderr, stdoutTail);
    return {
      ok: false,
      error: auth ? CODEX_LOGIN_MESSAGE : `codex가 종료 코드 ${run.code}로 끝났습니다${run.stderr ? ` - ${run.stderr.trim().slice(-400)}` : ""}`,
      authRequired: auth,
      durationMs,
      tokensUsed,
      stdoutTail,
    };
  }
  return { ok: true, durationMs, tokensUsed, stdoutTail };
}
