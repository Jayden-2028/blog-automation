// 선택된 키워드에 대한 추천 블로그 제목 생성.
//
// 생성 시점(SPRINT_1_DESIGN.md 7절): 알림을 보낼 때 10건 전부가 아니라, 사용자가 버튼으로
// 하나를 고른 뒤 그 1건에 대해서만 만든다. 알림 시점에 만들면 매일 10건 중 8~9건은 쓰이지도
// 않고 버려지고, 알림 도착도 생성 시간만큼 늦어진다.
//
// 실패해도 예외를 던지지 않는다. 제목은 나중에 다시 만들 수 있고, 제목 생성 실패가 이미
// 성공한 "키워드 선택"을 무효로 만들면 안 되기 때문이다(TelegramBot이 이 결과를 그렇게 다룬다).

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";

/** 만들 제목 개수. */
const TITLE_COUNT = 3;

/** 제목 생성은 짧은 작업이라 원고 생성보다 훨씬 짧게 잡는다. */
const TITLE_TIMEOUT_MS = 90_000;

export type GenerateTitleSuggestionsInput = {
  keyword: string;
  /** 원본 뉴스/블로그 제목. 키워드만으로는 맥락이 부족할 때가 많다. */
  headline?: string | null;
  category?: string | null;
};

function buildPrompt(input: GenerateTitleSuggestionsInput): string {
  const context = [
    `키워드: ${input.keyword}`,
    input.headline && input.headline !== input.keyword ? `원문 제목: ${input.headline}` : null,
    input.category ? `분야: ${input.category}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // 출력 형식을 강하게 고정한다 - 헤드리스 출력은 사람이 보는 게 아니라 파서가 읽는다.
  // 설명이나 머리말이 섞이면 그대로 제목으로 저장돼 버린다.
  return [
    "너는 한국어 블로그 제목을 쓰는 편집자다.",
    "",
    "아래 키워드로 네이버 블로그에 올릴 제목 후보를 정확히 " + TITLE_COUNT + "개 만들어라.",
    "",
    context,
    "",
    "규칙:",
    "- 한 줄에 제목 하나씩, 총 " + TITLE_COUNT + "줄만 출력한다",
    "- 번호, 따옴표, 불릿, 머리말, 설명, 마무리 문장을 일절 붙이지 않는다",
    "- 각 제목은 공백 포함 40자 이내",
    "- 검색해서 들어올 사람이 실제로 칠 법한 말을 제목 앞쪽에 둔다",
    "- 확인되지 않은 사실을 단정하지 않는다. 추측성 표현('~라는 의혹', '~한 듯')을 쓰지 않는다",
    "- 인물 관련이면 확정 보도된 사실만 다룬다",
    "- 과장된 낚시 표현(충격, 경악, 소름)을 쓰지 않는다",
  ].join("\n");
}

/**
 * 출력에서 제목만 골라낸다. 모델이 규칙을 어기고 번호나 따옴표를 붙이는 경우가 있어 방어적으로
 * 정리한다 - 여기서 못 걸러내면 "1. 제목" 같은 문자열이 그대로 저장된다.
 */
export function parseTitleLines(output: string, limit = TITLE_COUNT): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        // 앞의 번호/불릿 제거: "1. ", "1) ", "- ", "* ", "• "
        .replace(/^\s*(?:\d+\s*[.)]|[-*•])\s*/, "")
        // 양끝 따옴표 제거
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
        .trim()
    )
    .filter((line) => line.length > 0)
    // 모델이 머리말("다음은 ...입니다")을 붙이는 경우를 걸러낸다.
    .filter((line) => !/^(다음은|아래|추천|제목 후보)/.test(line))
    .slice(0, limit);
}

/**
 * 추천 제목을 만든다. 실패하면 빈 배열을 반환한다(던지지 않는다).
 */
export async function generateTitleSuggestions(input: GenerateTitleSuggestionsInput): Promise<string[]> {
  const result = await runHeadlessClaude({
    prompt: buildPrompt(input),
    timeoutMs: TITLE_TIMEOUT_MS,
  });

  if (!result.ok) {
    console.error("⚠️ 추천 제목 생성 실패 -", result.error);
    return [];
  }

  const titles = parseTitleLines(result.output);
  if (titles.length === 0) {
    console.error("⚠️ 추천 제목 생성 결과에서 제목을 찾지 못했습니다.");
  }
  return titles;
}
