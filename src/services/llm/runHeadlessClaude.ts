// Claude Code를 헤드리스(`claude -p`)로 1회 실행하는 얇은 래퍼.
//
// Sprint 1에서는 추천 제목 생성에, Sprint 2에서는 원고 생성(workflows/writing/runArticleJob.ts)에
// 쓴다. "무엇을 만들지"(프롬프트)는 호출자가 정하고, 이 모듈은 실행·타임아웃·출력 파싱만 담당한다.
//
// 왜 API가 아니라 CLI인가: Claude Code의 Skill(플러그인) 생태계를 그대로 재사용하려면 Claude Code
// 세션이 필요하다 - 프롬프트로 이식하면 스킬이 두 벌이 된다. 어느 스킬을 쓸지는 호출자의 프롬프트가
// 정한다(이 모듈은 관여하지 않는다).
//
// 원래 계획은 entertainment/parenting/trend-blog-writer(anthropic-skills:*)를 그대로 쓰는
// 것이었으나, 2026-08-27 실측 확인 결과 그 네임스페이스는 대화형 세션에만 있고 헤드리스
// CLI(`claude -p`)에서는 로드되지 않았다. 대신 moai-marketer:content-blog + moai-writer:korean-humanize를
// 쓴다(둘 다 헤드리스에서 사용 가능함을 확인함, SPRINT_2_DESIGN.md 2절).
//
// 안전 기본값:
// - 도구 사용을 켜지 않는다(allowedTools 기본 없음). 제목 생성 같은 순수 텍스트 작업에 파일
//   접근이나 명령 실행 권한을 줄 이유가 없다.
// - 타임아웃을 반드시 건다. 무인 job에서 자식 프로세스가 매달리면 전체가 멈춘다.
// - 예외를 던지지 않고 결과 객체로 성패를 알린다 - 호출자가 실패해도 파이프라인을 계속할 수
//   있어야 하기 때문이다.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * claude 실행 파일을 찾는다.
 *
 * 왜 "claude"만으로는 안 되는가(2026-08-27 실측): launchd로 띄운 job의 PATH는 로그인 셸과 다르다.
 * 이 맥의 claude는 ~/.local/bin에 있는데 plist PATH에는 그 경로가 없어 `spawn claude ENOENT`로
 * 제목 생성이 통째로 실패했다. plist PATH를 고치는 것만으로는 다른 호스트에서 또 깨지므로,
 * 흔한 설치 위치를 직접 확인한다.
 *
 * CLAUDE_CLI_PATH 환경변수를 주면 그것을 최우선으로 쓴다.
 */
function resolveClaudeBinary(): string {
  const fromEnv = process.env.CLAUDE_CLI_PATH;
  if (fromEnv) return fromEnv;

  const candidates = [
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  const found = candidates.find((path) => existsSync(path));

  // 못 찾으면 PATH 탐색에 맡긴다(대화형 셸에서 실행하는 경우 등).
  return found ?? "claude";
}

/** 기본 타임아웃. 제목 3개 생성에는 충분하고, 원고 생성은 호출자가 늘려 쓴다. */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 120_000;

export type RunHeadlessClaudeOptions = {
  prompt: string;
  timeoutMs?: number;
  /** 생략하면 도구를 전혀 허용하지 않는다. 원고 생성 단계에서 필요한 것만 명시적으로 넘긴다. */
  allowedTools?: string[];
  /** 실행 디렉터리. 생략하면 현재 프로세스의 cwd. */
  cwd?: string;
};

export type RunHeadlessClaudeResult =
  | { ok: true; output: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * `claude -p`를 1회 실행하고 stdout 텍스트를 돌려준다.
 * 프롬프트는 argv가 아니라 stdin으로 넘긴다 - 원고 길이의 프롬프트가 argv 길이 제한에 걸리거나
 * 셸 이스케이프 문제를 일으키지 않게 하기 위해서다.
 */
export async function runHeadlessClaude(options: RunHeadlessClaudeOptions): Promise<RunHeadlessClaudeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS;
  const startedAt = Date.now();

  const args = ["-p", "--output-format", "text"];
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowed-tools", options.allowedTools.join(","));
  }

  return new Promise<RunHeadlessClaudeResult>((resolve) => {
    let settled = false;
    const finish = (result: RunHeadlessClaudeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const claudeBinary = resolveClaudeBinary();
    const child = spawn(claudeBinary, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: `헤드리스 실행이 ${timeoutMs}ms 안에 끝나지 않아 중단했습니다.`,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `claude 실행 실패(${claudeBinary}): ${error.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (code !== 0) {
        finish({
          ok: false,
          error: `claude가 종료 코드 ${code}로 끝났습니다${stderr ? ` - ${stderr.trim().slice(0, 500)}` : ""}`,
          durationMs,
        });
        return;
      }

      const output = stdout.trim();
      if (!output) {
        finish({ ok: false, error: "claude가 빈 출력을 반환했습니다.", durationMs });
        return;
      }

      finish({ ok: true, output, durationMs });
    });

    child.stdin.write(options.prompt);
    child.stdin.end();
  });
}
