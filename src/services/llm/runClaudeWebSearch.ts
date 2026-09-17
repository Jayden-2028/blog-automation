// 웹 검색 + 구조화 JSON을 Claude(`claude -p`)로 실행한다. runHeadlessCodex와 **같은 계약**을 만족해서
// collectWebImages가 실행기를 바꿔 끼울 수 있다(WebSearchAgent).
//
// 왜 Codex가 아니라 이것이 기본이 됐나(2026-09-18): 어제 만든 Codex 경로는 맥 로컬 전용이라
// 파이프라인(GitHub Actions)에서 **한 번도 실행되지 않았다.** Codex CLI는 러너에 없고 ChatGPT OAuth도
// 못 쓴다 - 구조상 영원히 자동화가 안 되는 경로였다. 반면 파이프라인은 이미 `claude -p`를 돌리고
// 있고(제목 생성·원고 작성) CLAUDE_CODE_OAUTH_TOKEN도 들어가 있어, WebSearch 도구만 열면 같은 일을
// 클라우드에서 자동으로 할 수 있다.
//
// 판단 기준·권한 분류·해상도/비율 검증·비전 검증은 전부 그대로 재사용한다 - 바뀌는 건 "누가
// 검색하느냐"뿐이다.

import { runHeadlessClaude } from "./runHeadlessClaude.js";
import { extractTrailingJson } from "./runHeadlessCodex.js";
import type { RunHeadlessCodexOptions, RunHeadlessCodexResult } from "./runHeadlessCodex.js";

/** 웹 검색을 실제로 쓰려면 도구 허용과 권한 모드가 둘 다 필요하다(2026-09-01 실측, runHeadlessClaude 주석). */
const SEARCH_TOOLS = ["WebSearch", "WebFetch"];

export async function runClaudeWebSearch(options: RunHeadlessCodexOptions): Promise<RunHeadlessCodexResult> {
  // Claude CLI에는 --output-schema가 없다. 스키마를 프롬프트 끝에 붙여 형태를 요구하고,
  // 응답 끝에서 JSON을 찾는다(codex 쪽과 같은 extractTrailingJson을 쓴다).
  const prompt = [
    options.prompt,
    "",
    "## 출력 형식(엄격)",
    "마지막 줄에 **JSON 한 줄만** 출력한다. 코드펜스로 감싸지 않는다. 아래 JSON Schema를 정확히 따른다:",
    JSON.stringify(options.outputSchema),
  ].join("\n");

  const result = await runHeadlessClaude({
    prompt,
    allowedTools: options.search ? SEARCH_TOOLS : undefined,
    permissionMode: options.search ? "acceptEdits" : undefined,
    timeoutMs: options.timeoutMs ?? 600_000,
    cwd: options.cwd,
  });

  if (!result.ok) return { ok: false, error: result.error, durationMs: result.durationMs };

  const data = extractTrailingJson(result.output);
  if (data === null) {
    return {
      ok: false,
      error: `claude 출력에서 JSON을 찾지 못했습니다: ${result.output.trim().slice(-300)}`,
      durationMs: result.durationMs,
    };
  }

  return { ok: true, data, durationMs: result.durationMs };
}
