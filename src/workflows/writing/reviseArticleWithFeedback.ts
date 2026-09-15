// 검수 단계("✏️ 수정 필요")에서 사용자가 텔레그램 답장으로 보낸 수정 방향을 반영해 기준(네이버)
// 원고를 다시 쓴다(2026-09-15 사용자 요청).
//
// generateArticleVariant.ts와 같은 헤드리스 경로(claude -p + moai-marketer:content-blog +
// moai-writer:korean-humanize)를 쓴다 - 채널 배리에이션이 아니라 기준 원고 자체를 고치는 것만
// 다르다. 웹 검색을 주지 않는 이유도 같다: 기존 원고가 감사 기록이고, 새 사실을 끌어오면
// 추적성이 깨진다(팩트는 기존 원고에서만 가져온다 - 문체·구성·분량만 피드백대로 바꾼다).

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";

// 배리에이션과 같은 부하(writer.md 500줄+ 재독 + skill 2개) - 같은 타임아웃을 쓴다.
export const REVISION_TIMEOUT_MS = 20 * 60 * 1000;

export const REVISION_OUTPUT_MARKERS = {
  title: "### TITLE",
  body: "### BODY",
} as const;

export type RevisedArticle = {
  title: string;
  body: string;
};

export type ReviseArticleResult =
  | { status: "success"; revised: RevisedArticle; durationMs: number }
  | { status: "failed"; error: string };

export type ReviseArticleInput = {
  keyword: string;
  category: string | null;
  originalTitle: string;
  /** 기존 기준 원고 본문(마크다운, 해시태그 줄·이미지 마커 포함). */
  originalBody: string;
  /** 사용자가 텔레그램 답장으로 보낸 수정 방향 원문. */
  feedback: string;
  /** 테스트 주입 지점. 기본은 runHeadlessClaude(claude -p). */
  generate?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

function buildPrompt(input: ReviseArticleInput): string {
  const { keyword, category, originalTitle, originalBody, feedback } = input;
  const M = REVISION_OUTPUT_MARKERS;

  return [
    `당신은 이미 쓴 블로그 원고를, 편집자(사람)의 수정 지시에 맞춰 다시 쓴다.`,
    `moai-marketer:content-blog 스킬로 다듬고 moai-writer:korean-humanize로 마무리한다.`,
    ``,
    `먼저 prompts/writing/writer.md를 Read해 문체·구조·사실 태도(§4 확인/헤지 금지) 원칙과`,
    `서식 규칙(§6 - 소제목은 "**볼드**" 한 줄, [IMAGE: ...] 마커 등)을 따른다.`,
    `단, 출력은 writer.md §9(파일 저장)가 아니라 아래 ### 마커 형식으로 한다.`,
    ``,
    `## 절대 규칙 - 사실 보존`,
    `- 기존 원고에 있는 수치·날짜·금액·고유명사·인용·제도명은 편집자가 명시적으로 바꾸라고 지시하지`,
    `  않는 한 그대로 유지한다. 새로운 사실·수치·날짜를 추가하지 않는다(웹 검색 없음, 기존 원고가`,
    `  유일한 사실 출처다).`,
    ``,
    `## 절대 규칙 - 수정 지시 반영`,
    `- 아래 "편집자 피드백"에 적힌 방향을 정확히 반영한다. 피드백이 언급하지 않은 부분(사실,`,
    `  구조, 톤)은 원래 원고를 그대로 유지한다 - 요청받지 않은 부분까지 임의로 고치지 않는다.`,
    `- [IMAGE: 설명] 마커가 원문에 있으면, 피드백이 이미지 관련 수정을 요구하지 않는 한 같은 자리에`,
    `  같은 설명으로 그대로 남긴다(이미지는 사람이 나중에 삽입한다).`,
    `- 원고 끝의 해시태그 줄(#으로 시작하는 줄)이 있으면 그대로 유지한다.`,
    category ? `- 카테고리: ${category}. 그 분야 개인 블로그 톤을 유지한다.` : ``,
    ``,
    `## 출력 형식 (아래 마커를 정확히 그대로, 순서대로)`,
    `${M.title}`,
    `(수정 반영한 제목 1줄 - 피드백이 제목 변경을 요구하지 않으면 원제목 그대로)`,
    `${M.body}`,
    `(마크다운 본문 전체 - 수정 반영한 최종본. 점검 결과·작업 노트 같은 메타 텍스트를 절대 붙이지 않는다.)`,
    ``,
    `## 편집자 피드백`,
    feedback,
    ``,
    `## 기존 원고 (키워드: ${keyword} / 제목: ${originalTitle})`,
    originalBody,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

function sliceBetween(text: string, startMarker: string, endMarkers: string[]): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const from = start + startMarker.length;
  const ends = endMarkers.map((m) => text.indexOf(m, from)).filter((i) => i !== -1);
  const to = ends.length > 0 ? Math.min(...ends) : text.length;
  return text.slice(from, to).trim();
}

export function parseRevisionOutput(raw: string, fallbackTitle: string): RevisedArticle {
  const M = REVISION_OUTPUT_MARKERS;
  const title = sliceBetween(raw, M.title, [M.body]).split("\n")[0]?.trim() || fallbackTitle;
  const body = sliceBetween(raw, M.body, []) || raw.trim();
  return { title, body };
}

export async function reviseArticleWithFeedback(input: ReviseArticleInput): Promise<ReviseArticleResult> {
  const generate =
    input.generate ??
    ((prompt: string) =>
      runHeadlessClaude({
        prompt,
        allowedTools: ["Skill", "Read"],
        permissionMode: "acceptEdits",
        cwd: PIPELINE_ROOT,
        timeoutMs: REVISION_TIMEOUT_MS,
      }));

  const startedAt = Date.now();
  const result = await generate(buildPrompt(input));
  if (!result.ok) {
    return { status: "failed", error: result.error };
  }

  // generateArticleVariant.ts와 같은 이유(2026-09-06 실측) - 마커를 안 지킨 대화체 회신을 그대로
  // "성공"으로 통과시키지 않는다.
  const missingMarkers = Object.values(REVISION_OUTPUT_MARKERS).filter((marker) => !result.output.includes(marker));
  if (missingMarkers.length > 0) {
    return {
      status: "failed",
      error: `모델이 출력 마커 형식을 따르지 않았습니다(누락: ${missingMarkers.join(", ")}). 원문 시작: ${result.output.slice(0, 200)}`,
    };
  }

  const revised = parseRevisionOutput(result.output, input.originalTitle);
  if (!revised.body || revised.body.length < 300) {
    return { status: "failed", error: `수정된 본문이 너무 짧습니다 (${revised.body.length}자)` };
  }

  return { status: "success", revised, durationMs: Date.now() - startedAt };
}
