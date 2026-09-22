// 자료조사가 끝난 뒤 기획 브리프를 다시 쓴다(2026-09-22).
//
// 왜 필요한가(사용자 지적으로 딥다이브): 1차 브리프는 **자료조사 전에 제목만 보고** 만든다.
// 본문을 한 줄도 안 읽으므로 추정이고, 한국어 헤드라인에서는 주어조차 못 가린다.
//
//   제목: "'로또 1등' 서현우, 제대로 사고쳤다"
//   1차 브리프: 서현우가 로또 1등 당첨자다   ← '로또 1등'은 드라마 제목 약칭이다
//   실제:      당첨자는 이준혁
//
// 집필이 사실은 바로잡았지만 **질문은 그대로 따라갔다.** 브리프만 헷갈린 것이 "많은 사람이
// 헷갈리는 지점"이라는 소제목과 FAQ 한 칸이 됐고, 정작 실제 화제 포인트(직장인 현실 공감,
// 태세 전환의 카타르시스)는 원고에 없었다.
//
// 그래서 역할을 나눈다.
//   1차 브리프(제목 기반) - **리서치가 무엇을 찾을지** 정한다. 원래 목적 그대로.
//   2차 브리프(본문 기반) - **원고 소제목의 뼈대**가 된다. 여기서 사실과 각도를 바로잡는다.
//
// 실패해도 집필을 막지 않는다 - 2차가 없으면 1차를 그대로 쓴다(지금까지의 동작).

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import { parseBriefOutput } from "./buildKeywordBrief.js";
import type { KeywordBrief } from "./buildKeywordBrief.js";

/** 1차 브리프보다 짧게 잡는다 - 재료(리서치)가 이미 있어 판단만 하면 된다. */
export const BRIEF_REVISE_TIMEOUT_MS = 4 * 60 * 1000;

export type ReviseBriefInput = {
  keyword: string;
  brief: KeywordBrief;
  /** 자료조사 본문. 여기 있는 사실만 근거로 쓴다. */
  research: string;
};

export function buildRevisePrompt(input: ReviseBriefInput): string {
  return [
    "너는 블로그 편집장이다. 자료조사가 끝났다. **조사 전에 제목만 보고 잡았던 질문 목록**을",
    "지금 읽은 자료에 비추어 다시 쓴다. 이 목록이 곧 원고의 소제목 뼈대가 된다.",
    "",
    `## 키워드`,
    input.keyword,
    "",
    "## 조사 전에 잡았던 브리프 (추정이다 - 틀릴 수 있다)",
    `HOOK: ${input.brief.hook}`,
    ...input.brief.questions.map((question, index) => `Q${index + 1}: ${question}`),
    `ACTION: ${input.brief.action || "없음"}`,
    "",
    "## 자료조사 결과 (사실은 여기에만 있다)",
    input.research,
    "",
    "## 무엇을 고치나",
    "1. **사실이 틀렸으면 고친다.** 제목만 보고 주어를 반대로 잡는 일이 실제로 있었다",
    "   (\"'로또 1등' 서현우\"를 서현우가 당첨자로 읽었는데, '로또 1등'은 드라마 제목 약칭이고",
    "   당첨자는 이준혁이었다). 틀린 전제로 만든 질문은 **버린다** - 사실만 고쳐 남기면 그 오해가",
    "   \"많은 사람이 헷갈리는 지점\" 같은 기사 각도로 굳는다.",
    "2. **각도가 빗나갔으면 바꾼다.** 특히 '왜 화제인가'는 조사 전에는 짐작일 뿐이다. 자료에",
    "   드러난 **실제 반응**으로 바꾼다(실측: 브리프는 '출연진 케미'라 했지만 실제 반응은",
    "   '직장인 현실 공감'과 '태세 전환의 카타르시스'였다).",
    "3. **이미 답이 나온 질문은 버린다.** 자료를 읽고 나면 자명해진 것(\"이 여배우가 누구인가\")은",
    "   질문 한 칸을 낭비하는 것이다. 그 칸에 독자가 진짜 궁금해할 것을 넣는다.",
    "4. **겹치는 질문은 합친다.** 같은 사실을 각도만 바꿔 두 번 묻지 않는다.",
    "5. **자료에 답이 없는 질문은 그대로 둔다.** 못 찾았다는 사실도 정보다 - 여기서 지우면",
    "   원고가 그 질문을 아예 안 다룬 것처럼 보인다.",
    "",
    "바꿀 것이 없으면 그대로 두어도 된다. 억지로 고치지 마라.",
    "",
    "## 출력 (이 형식만, 다른 말 없이)",
    "HOOK: 자료를 읽은 뒤의 가장 센 한 줄",
    "Q1: ...",
    "Q2: ...",
    "Q3: ...",
    "Q4: ...",
    "Q5: ...",
    "ACTION: 읽고 나서 독자가 할 수 있는 행동 한 줄 (없으면 '없음')",
    "CHANGED: 바꾼 질문과 이유를 한 줄로 (안 바꿨으면 '없음')",
  ].join("\n");
}

export type ReviseBriefResult =
  | { status: "revised"; brief: KeywordBrief; changed: string }
  | { status: "unchanged"; brief: KeywordBrief }
  | { status: "failed"; error: string };

export type ReviseBriefOptions = {
  runClaude?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

/**
 * 1차 브리프를 리서치에 비추어 다시 쓴다.
 *
 * 실패하면 `failed`를 돌려주고 호출부가 1차를 그대로 쓴다 - 여기서 예외를 던져 집필을 막지 않는다.
 */
export async function reviseBriefWithResearch(
  input: ReviseBriefInput,
  options: ReviseBriefOptions = {}
): Promise<ReviseBriefResult> {
  const research = input.research.trim();
  if (!research) return { status: "failed", error: "자료조사 내용이 비어 있습니다." };

  const runClaude =
    options.runClaude ??
    ((prompt) => runHeadlessClaude({ prompt, timeoutMs: BRIEF_REVISE_TIMEOUT_MS }));

  const result = await runClaude(buildRevisePrompt(input));
  if (!result.ok) return { status: "failed", error: result.error };

  const parsed = parseBriefOutput(result.output);
  if (!parsed || parsed.questions.length === 0) {
    return { status: "failed", error: "재작성 결과를 읽지 못했습니다." };
  }

  const changedLine = /^CHANGED:\s*(.+)$/m.exec(result.output)?.[1]?.trim() ?? "";
  const changed = changedLine && !/^없음$/.test(changedLine) ? changedLine : "";

  // type과 autocomplete는 1차 것을 유지한다 - 유형은 리서치 프로파일을 이미 골랐고,
  // 자동완성은 감사용 원본이라 덮어쓸 이유가 없다.
  const brief: KeywordBrief = {
    ...input.brief,
    hook: parsed.hook || input.brief.hook,
    questions: parsed.questions,
    action: parsed.action,
  };

  return changed ? { status: "revised", brief, changed } : { status: "unchanged", brief };
}
