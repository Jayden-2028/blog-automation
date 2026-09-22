// Codex CLI(`codex exec`)를 헤드리스로 1회 실행하고 구조화된 JSON을 돌려준다.
// runHeadlessClaude.ts와 같은 역할·같은 안전 기본값을 Codex 쪽에 맞춘 것이다.
//
// 왜 Claude가 아니라 Codex인가(2026-09-16 사용자 결정): 웹 검색 이미지를 AI로 대체 생성해 봤더니
// 저품질이 너무 많았다. 실제 사진·공식 자료 화면이 필요한 자리는 "만드는" 게 아니라 "찾는"
// 작업이고, `codex exec --search`는 OpenAI의 네이티브 web_search 도구를 그대로 쓴다.
//
// 샌드박스: read-only로 고정한다. 이 경로에서 Codex가 할 일은 검색과 판단뿐이고, 파일을
// 내려받아 배치하는 것은 Node가 한다(검증 가능한 쪽에 두려는 의도 - collectWebImages.ts 참고).
// 그래서 delegate-codex 스킬의 "저장소 밖에 쓰지 않는다" 규칙을 완화할 필요가 없다.
//
// `--search`가 켜지면 검색은 OpenAI 서버에서 실행된다 - 샌드박스의 네트워크 권한과 무관하다.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** codex 실행 파일. PATH가 로그인 셸과 다른 환경(launchd 등)을 대비해 흔한 설치 위치를 직접 본다. */
function resolveCodexBinary(): string {
  const fromEnv = process.env.CODEX_CLI_PATH;
  if (fromEnv) return fromEnv;

  const candidates = [
    join(homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find((path) => existsSync(path)) ?? "codex";
}

/** 웹 검색이 붙으면 한 자리당 수십 초가 걸린다. 원고 1건(슬롯 여러 개)을 한 번에 돌리는 전제다. */
export const DEFAULT_CODEX_TIMEOUT_MS = 600_000;

export type RunHeadlessCodexOptions = {
  prompt: string;
  /** 최종 응답 형태를 강제하는 JSON Schema. 객체를 주면 임시 파일로 써서 --output-schema에 넘긴다. */
  outputSchema: Record<string, unknown>;
  /** 실시간 웹 검색(네이티브 web_search 도구)을 켠다. */
  search?: boolean;
  timeoutMs?: number;
  cwd?: string;
};

export type RunHeadlessCodexResult =
  | { ok: true; data: unknown; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * 웹 검색 + 구조화 JSON을 돌려주는 실행기의 공통 계약. Codex(로컬)와 Claude(클라우드)가 이 모양을
 * 똑같이 만족해서 호출부(collectWebImages)가 어느 쪽인지 모르고 쓸 수 있다.
 */
export type WebSearchAgent = (options: RunHeadlessCodexOptions) => Promise<RunHeadlessCodexResult>;

/**
 * stdout 끝에서 JSON을 찾는다.
 *
 * 왜 마지막 줄만 보지 않는가(2026-09-16 실측): codex exec는 세션 헤더·플러그인 로드 경고·
 * "tokens used" 같은 잡음을 함께 뱉고, 최종 JSON이 한 번이 아니라 두 번(응답 본문 + 마지막 요약)
 * 찍히기도 한다. 끝에서부터 거슬러 올라가며 처음으로 파싱되는 줄을 쓰면 형식이 조금 흔들려도 견딘다.
 */
/**
 * 문자열·이스케이프를 건너뛰며 괄호 균형을 맞춰, 텍스트에서 **마지막 JSON 덩어리**를 찾는다.
 *
 * 왜 필요한가(2026-09-22 실측): 원래는 줄 단위로만 파싱했다. 에이전트가 JSON을 여러 줄로 예쁘게
 * 출력하면 어느 줄도 단독으로는 파싱되지 않아 **결과를 통째로 버렸다** - 주현영 원고에서 검색이
 * 조선비즈·더쿠 후보를 다 찾아놓고도 "JSON을 찾지 못했습니다"로 끝났다.
 */
function findBalancedJson(text: string): unknown | null {
  const closers = new Set(["}", "]"]);
  for (let end = text.length - 1; end >= 0; end -= 1) {
    if (!closers.has(text[end])) continue;

    // 이 닫는 괄호와 짝이 맞는 여는 괄호를 뒤에서 앞으로 찾는다.
    let depth = 0;
    let inString = false;
    for (let start = end; start >= 0; start -= 1) {
      const ch = text[start];

      if (inString) {
        // 앞의 백슬래시 개수가 홀수면 이스케이프된 따옴표다.
        if (ch === '"') {
          let slashes = 0;
          for (let k = start - 1; k >= 0 && text[k] === "\\"; k -= 1) slashes += 1;
          if (slashes % 2 === 0) inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "}" || ch === "]") depth += 1;
      else if (ch === "{" || ch === "[") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, end + 1));
          } catch {
            break; // 이 구간은 JSON이 아니다 - 더 앞의 닫는 괄호로 넘어간다.
          }
        }
      }
    }
  }
  return null;
}

export function extractTrailingJson(stdout: string): unknown | null {
  // 빠른 경로: 한 줄에 통째로 담긴 경우(대부분).
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }

  // 여러 줄에 걸쳐 있거나 앞뒤에 설명이 붙은 경우.
  return findBalancedJson(stdout);
}

export async function runHeadlessCodex(options: RunHeadlessCodexOptions): Promise<RunHeadlessCodexResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const startedAt = Date.now();

  const schemaDir = await mkdtemp(resolve(tmpdir(), "codex-schema-"));
  const schemaPath = resolve(schemaDir, "schema.json");
  await writeFile(schemaPath, JSON.stringify(options.outputSchema, null, 2));

  // 웹 검색은 `-c tools.web_search=true`로 켠다. `--search`는 대화형 `codex`의 플래그이고
  // `codex exec`는 받지 않는다(2026-09-16 실측: "unexpected argument '--search' found").
  const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--output-schema", schemaPath];
  if (options.search) args.push("-c", "tools.web_search=true");
  args.push("-");

  try {
    return await new Promise<RunHeadlessCodexResult>((resolvePromise) => {
      let settled = false;
      const finish = (result: RunHeadlessCodexResult): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };

      const binary = resolveCodexBinary();
      const child = spawn(binary, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });

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
        finish({ ok: false, error: `Codex 실행이 ${timeoutMs}ms 안에 끝나지 않아 중단했습니다.`, durationMs: Date.now() - startedAt });
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ ok: false, error: `codex 실행 실패(${binary}): ${error.message}`, durationMs: Date.now() - startedAt });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;

        if (code !== 0) {
          finish({
            ok: false,
            error: `codex가 종료 코드 ${code}로 끝났습니다${stderr ? ` - ${stderr.trim().slice(-500)}` : ""}`,
            durationMs,
          });
          return;
        }

        const data = extractTrailingJson(stdout);
        if (data === null) {
          finish({ ok: false, error: `codex 출력에서 JSON을 찾지 못했습니다: ${stdout.trim().slice(-300)}`, durationMs });
          return;
        }

        finish({ ok: true, data, durationMs });
      });

      child.stdin.write(options.prompt);
      child.stdin.end();
    });
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
}
