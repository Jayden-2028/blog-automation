// 키워드 알림(TOP N) 항목마다 붙일 20자 내외 한 줄 요약을 만든다.
//
// 왜 필요한가(2026-09-15 사용자 요청): 알림에 키워드 제목·seedQuery·카테고리만 있으면 그 키워드가
// 실제로 무슨 내용인지 클릭 전에는 알기 어렵다. `headline`(원문 기사 제목)은 그대로 쓰기엔 너무
// 길어서 2026-09-04에 이미 한 번 뺐던 필드라 재사용하지 않는다(formatNotificationMessage.ts 참고) -
// 대신 headless Claude로 짧은 요약을 새로 만든다.
//
// 알림 1건(최대 10개 항목)당 LLM 호출 1회로 묶는다(항목마다 호출하면 최대 10콜 - 알림 도착이
// 그만큼 늦어지고 호출 수도 늘어난다). generateTitleSuggestions.ts와 같은 이유로 JSON이 아니라
// "항목당 한 줄" 출력을 쓴다 - 헤드리스 출력은 파서가 읽는데, 줄 수와 순서만 맞으면 되는 이 형식이
// JSON 이스케이프 실수보다 깨지기 어렵다.
//
// 실패해도 예외를 던지지 않는다(generateTitleSuggestions.ts와 같은 원칙) - 요약 생성 실패가 키워드
// 알림 자체를 막으면 안 된다. 실패하거나 줄 수가 안 맞으면 그 항목은 요약 없이(null) 나간다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";

const SUMMARY_TIMEOUT_MS = 60_000;
const TARGET_LENGTH = 20;

export type KeywordSummaryInput = {
  keyword: string;
  headline: string | null;
  seedQuery: string | null;
  category: string | null;
};

function buildPrompt(items: KeywordSummaryInput[]): string {
  const list = items
    .map((item, index) => {
      const context = [
        `키워드: ${item.keyword}`,
        item.headline && item.headline !== item.keyword ? `원문 제목: ${item.headline}` : null,
        item.category ? `분야: ${item.category}` : null,
      ]
        .filter(Boolean)
        .join(" / ");
      return `${index + 1}. ${context}`;
    })
    .join("\n");

  return [
    "너는 한국어 뉴스 키워드를 한눈에 알아볼 수 있게 아주 짧게 요약하는 편집자다.",
    "",
    `아래 ${items.length}개 키워드 각각에 대해, 무슨 내용인지 공백 포함 ${TARGET_LENGTH}자 내외(15~24자)로 한 줄씩 요약해라.`,
    "",
    list,
    "",
    "규칙:",
    `- 정확히 ${items.length}줄만 출력한다(입력 순서 그대로, 한 항목당 한 줄)`,
    "- 번호, 따옴표, 불릿, 머리말, 설명을 절대 붙이지 않는다 - 요약 문장만 쓴다",
    "- 키워드를 그대로 반복하지 말고 무슨 일이 있었는지/무슨 내용인지를 요약한다",
    "- 확인되지 않은 사실을 단정하지 않는다. 추측성 표현을 쓰지 않는다",
    "- 문장 부호(마침표 등)로 끝맺지 않는다",
  ].join("\n");
}

/** 모델이 규칙을 어기고 번호·따옴표를 붙이는 경우를 방어적으로 정리한다(parseTitleLines와 동일 원칙). */
function parseSummaryLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^\s*(?:\d+\s*[.)]|[-*•])\s*/, "")
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
        .trim()
    )
    .filter((line) => line.length > 0);
}

/**
 * items와 같은 길이·순서의 배열을 반환한다(매칭 안 되는 항목은 null). 호출 자체가 실패하면
 * 전부 null인 배열을 반환한다 - 던지지 않는다.
 */
export async function generateKeywordSummaries(items: KeywordSummaryInput[]): Promise<Array<string | null>> {
  if (items.length === 0) return [];

  const result = await runHeadlessClaude({
    prompt: buildPrompt(items),
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });

  if (!result.ok) {
    console.error("⚠️ 키워드 요약 생성 실패 -", result.error);
    return items.map(() => null);
  }

  const lines = parseSummaryLines(result.output);
  if (lines.length !== items.length) {
    console.error(`⚠️ 키워드 요약 줄 수 불일치(요청 ${items.length}, 응답 ${lines.length}) - 매칭되는 만큼만 사용`);
  }

  return items.map((_, index) => lines[index] ?? null);
}
