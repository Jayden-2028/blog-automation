// 자료조사 1건을 Codex CLI(GPT-6.1 Sol, 네이티브 web_search)로 돌린다(2026-11-01).
//
// 왜 Codex인가(2026-11-01 실측 비교): 같은 주제로 Claude와 붙여 보니 공식 출처를 훨씬 많이
// 찾아왔다 - "한국 전국 10대 도시 지역별 특산품"에서 공식 출처 21건 대 7건, go.kr 13곳 대 5곳
// (도시별 시청 공식 페이지를 각각 찾아냈다). "korea apartment management fee"는 13건 대 10건.
// 다만 1건당 143k~325k 토큰을 먹어 Plus 한도로 상시 운용이 안 된다 - 그래서 평소 Claude,
// Claude 한도가 빠듯할 때만 사용자가 RESEARCH_PROVIDER=codex로 켠다.
//
// **맥에서만 돈다.** Codex CLI와 ChatGPT 구독 로그인(~/.codex/auth.json)이 맥에만 있어서다.
// 구독 로그인은 스스로 갱신되므로 토큰 비밀값을 클라우드로 옮길 수도 없다. GitHub Actions에서
// 호출되면 조용히 실패하지 말고 이유를 분명히 말하고 멈춘다(불변식 ②).
//
// 프롬프트는 Gemini용 빌더를 그대로 쓴다 - "파일을 쓰지 말고 완성된 markdown을 답으로 돌려라"
// 변형이 필요한 건 Codex도 같다(샌드박스 read-only라 Write를 쓸 수 없다). 저장은 호출자가 한다.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runHeadlessCodex } from "./runHeadlessCodex.js";
import type { RunHeadlessCodexOptions, RunHeadlessCodexResult } from "./runHeadlessCodex.js";
import { extractTrailingJson } from "./runHeadlessCodex.js";
import { buildGeminiResearchPrompt } from "../../workflows/research/buildGeminiResearchPrompt.js";
import type { BuildGeminiResearchPromptInput } from "../../workflows/research/buildGeminiResearchPrompt.js";

/** 실측 최대 840초(14분). 검색이 길어지는 주제가 있어 25분까지 기다린다. */
export const CODEX_RESEARCH_TIMEOUT_MS = 25 * 60 * 1000;

/** 파싱에 실패한 stdout 원문을 남기는 곳. 15분치 실행을 재분석 없이 버리지 않기 위한 것이다. */
export const CODEX_RESEARCH_DUMP_DIR = "logs/codex-research";

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    research_markdown: {
      type: "string",
      description: "완성된 research/<키워드>.md 파일 전문. 첫 글자부터 `---`(frontmatter)여야 한다.",
    },
  },
  required: ["research_markdown"],
  additionalProperties: false,
};

/** buildGeminiResearchPrompt 뒤에 붙이는 출력 계약. outputSchema와 짝이 맞아야 한다. */
export const CODEX_OUTPUT_CONTRACT = [
  "",
  "출력 계약(위 '출력 형식'을 이 한 줄이 대체한다):",
  '- 최종 응답은 JSON 객체 하나다: {"research_markdown": "<파일 전문>"}',
  "- research_markdown 값은 위 규격대로 완성된 markdown 파일 전문이고, 첫 글자는 `---`다.",
  "- 그 밖의 키·설명·코드블록을 붙이지 않는다.",
].join("\n");

export function buildCodexResearchPrompt(
  input: BuildGeminiResearchPromptInput,
  researcherSpec?: string
): string {
  const base = researcherSpec === undefined ? buildGeminiResearchPrompt(input) : buildGeminiResearchPrompt(input, researcherSpec);
  return `${base}\n${CODEX_OUTPUT_CONTRACT}`;
}

/** 파싱된 값이 쓸 만한 조사 본문인지. 빈 문자열·한 줄짜리 사과문을 성공으로 받지 않는다. */
function asResearchMarkdown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const markdown = (value as Record<string, unknown>).research_markdown;
  if (typeof markdown !== "string") return null;
  const trimmed = markdown.trim();
  return trimmed.length >= 200 ? trimmed : null;
}

/**
 * codex exec stdout에서 research_markdown을 꺼낸다.
 *
 * 왜 이렇게 공들이는가(2026-11-01 실측 함정): stdout에는 세션 헤더·플러그인 경고·"tokens used"가
 * 섞이고 최종 JSON이 **두 번** 찍히기도 한다. 한 번은 이 함정으로 15분치 실행을 통째로 날렸다.
 * 그래서 두 단계로 시도한다:
 *   ① extractTrailingJson - 끝에서부터 괄호 균형을 맞춰 찾는 기존 공용 파서(대부분 여기서 끝난다).
 *   ② 마지막 `{"research_markdown"` 위치에서 시작해 끝의 `}`를 하나씩 줄여 가며 JSON.parse -
 *      ①이 뒤쪽 잡음 때문에 엉뚱한 덩어리를 잡았거나, JSON 뒤에 꼬리가 붙은 경우를 건진다.
 */
export function extractResearchMarkdown(stdout: string): string | null {
  const first = asResearchMarkdown(extractTrailingJson(stdout));
  if (first) return first;

  // ② 역방향 재시도. 키 표기는 공백이 끼어도 받는다("{ "research_markdown"").
  const keyPattern = /\{\s*"research_markdown"/g;
  const starts: number[] = [];
  for (let match = keyPattern.exec(stdout); match !== null; match = keyPattern.exec(stdout)) {
    starts.push(match.index);
  }
  for (const start of starts.reverse()) {
    for (let end = stdout.length; end > start; end -= 1) {
      if (stdout[end - 1] !== "}") continue;
      try {
        const parsed = asResearchMarkdown(JSON.parse(stdout.slice(start, end)));
        if (parsed) return parsed;
      } catch {
        // 이 닫는 괄호는 짝이 아니다 - 더 앞의 `}`로 좁힌다.
      }
    }
  }
  return null;
}

export type RunCodexResearchInput = BuildGeminiResearchPromptInput & {
  /** 덤프 파일 이름에 쓸 식별자(job id 등). 비밀값을 넣지 말 것 - 파일명에 그대로 들어간다. */
  label?: string;
  timeoutMs?: number;
  researcherSpec?: string;
  /** 테스트 주입. 기본은 runHeadlessCodex. */
  run?: (options: RunHeadlessCodexOptions) => Promise<RunHeadlessCodexResult>;
  /** 테스트 주입. 기본은 logs/codex-research 아래에 쓴다. */
  dumpStdout?: (stdout: string) => Promise<string | null>;
  /** 테스트 주입. 기본은 process.env.GITHUB_ACTIONS 확인. */
  isGithubActions?: () => boolean;
};

export type RunCodexResearchResult =
  | { ok: true; markdown: string; durationMs: number }
  | { ok: false; error: string; durationMs: number; dumpPath?: string };

async function defaultDumpStdout(stdout: string, label: string): Promise<string | null> {
  if (!stdout.trim()) return null;
  try {
    await mkdir(CODEX_RESEARCH_DUMP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "unknown";
    const path = resolve(CODEX_RESEARCH_DUMP_DIR, `${stamp}-${safeLabel}.stdout.txt`);
    await writeFile(path, stdout, "utf8");
    return path;
  } catch {
    return null; // 덤프 실패가 조사 실패 보고를 막지 않는다.
  }
}

export async function runCodexResearch(input: RunCodexResearchInput): Promise<RunCodexResearchResult> {
  const isActions = input.isGithubActions ?? (() => process.env.GITHUB_ACTIONS === "true");
  if (isActions()) {
    // 불변식 ②: Codex CLI·구독 로그인이 맥에만 있다. 여기까지 왔다면 발화 분기가 잘못된 것이다.
    return {
      ok: false,
      durationMs: 0,
      error:
        "Codex 조사는 GitHub Actions에서 돌 수 없습니다(CLI·구독 로그인이 맥에만 있습니다). " +
        "RESEARCH_PROVIDER=codex면 맥미니 폴러(job:research-poll)가 처리해야 합니다 - 발화 분기를 확인하세요.",
    };
  }

  let prompt: string;
  try {
    prompt = buildCodexResearchPrompt(input, input.researcherSpec);
  } catch (error) {
    return { ok: false, durationMs: 0, error: `researcher.md 로드 실패: ${error instanceof Error ? error.message : String(error)}` };
  }

  const run = input.run ?? runHeadlessCodex;
  const result = await run({
    prompt,
    outputSchema: OUTPUT_SCHEMA,
    search: true,
    timeoutMs: input.timeoutMs ?? CODEX_RESEARCH_TIMEOUT_MS,
  });

  const label = input.label ?? input.job.keyword;
  const dump = input.dumpStdout ?? ((stdout: string) => defaultDumpStdout(stdout, label));

  // ok여도 data 모양을 다시 확인한다 - runHeadlessCodex의 파서가 잡음 덩어리를 집었을 수 있다.
  const fromData = result.ok ? asResearchMarkdown(result.data) : null;
  if (fromData) return { ok: true, markdown: fromData, durationMs: result.durationMs };

  // 공용 파서가 못 꺼냈으면 원문에서 직접 꺼낸다(②). 실패한 실행도 stdout에 답이 들어 있을 수 있다.
  const fromStdout = result.rawStdout ? extractResearchMarkdown(result.rawStdout) : null;
  if (fromStdout) return { ok: true, markdown: fromStdout, durationMs: result.durationMs };

  const dumpPath = result.rawStdout ? await dump(result.rawStdout) : null;
  const reason = result.ok ? "응답에서 research_markdown을 찾지 못했습니다" : result.error;
  return {
    ok: false,
    durationMs: result.durationMs,
    error: `${reason}${dumpPath ? ` (stdout 원문: ${dumpPath})` : ""}`,
    ...(dumpPath ? { dumpPath } : {}),
  };
}
