// 수집된 근거(sources)를 사람이 30초 안에 "이 키워드로 써도 될까"를 판단할 수 있는 짧은 요약으로
// 압축한다. runResearchStage 직후, notifyResearchReady가 보내기 전에 호출한다.
//
// 왜 필요한가(2026-08-27, 사용자 피드백): 첫 체크포인트 구현은 출처별 제목+150자 발췌+URL을
// 그대로 나열했다. 실제로 받아보니 여러 출처가 네비게이션 메뉴("참여/소식 행사 공연/전시...")나
// 조각난 문장으로 시작해 있었고, 핵심을 파악하려면 링크를 일일이 열어봐야 했다 - "체크포인트에서
// 값싸게 판단한다"는 원래 취지(SPRINT_2_DESIGN.md 13절)와 반대로 오히려 원고 전체를 읽는 것보다
// 불편했다. 그래서 요약 자체를 LLM에 맡긴다: 원고를 쓰는 게 아니라 "쓸 가치가 있는지 판단하는 데
// 필요한 사실만" 뽑게 한다.
//
// 이 호출도 비용이다(제목 생성과 비슷한 수 초~수십 초, 원고 생성 185초보다는 훨씬 짧다) - 체크포인트
// 자체가 "원고 생성 전에 값싸게 거른다"는 목적이므로 트레이드오프가 맞다고 판단했다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { buildFactCard } from "./buildFactCard.js";
import type { ArticleJobRow, SourceRow } from "../../types/database.js";

/** 제목 생성과 비슷한 짧은 텍스트 작업이라 원고 생성(WRITE_TIMEOUT_MS=10분)보다 훨씬 짧게 잡는다. */
export const SUMMARIZE_RESEARCH_TIMEOUT_MS = 90_000;

export type SummarizeResearchInput = {
  job: Pick<ArticleJobRow, "keyword" | "headline" | "category">;
  sources: SourceRow[];
  /** 마감일 판정 기준 "오늘". 테스트에서 고정 날짜를 주입한다. 생략하면 실행 시각. */
  today?: string;
};

export type SummarizeResearchOptions = {
  /** 테스트에서 실제 LLM 호출을 대체하는 주입 지점. */
  generateSummary?: (prompt: string) => Promise<{ ok: true; output: string } | { ok: false; error: string }>;
};

export type SummarizeResearchResult =
  | { ok: true; summary: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

function buildPrompt(input: SummarizeResearchInput): string {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const context = [
    `키워드: ${input.job.keyword}`,
    input.job.headline && input.job.headline !== input.job.keyword ? `원문 제목: ${input.job.headline}` : null,
    input.job.category ? `분야: ${input.job.category}` : null,
    `오늘 날짜: ${today}`,
  ]
    .filter(Boolean)
    .join("\n");

  const factCard = buildFactCard(input.sources);

  // 출력 형식을 강하게 고정한다 - 이 출력은 그대로 Telegram 메시지 본문이 된다. 사람이 30초 안에
  // 읽고 결정해야 하므로 군더더기(머리말, 맺음말, 마크다운 강조)를 넣지 않게 명시한다.
  return [
    "너는 블로그 원고 작성 여부를 판단하는 데스크 에디터다.",
    "아래는 한 키워드에 대해 자동 수집된 근거 자료다(공식 사이트 본문 발췌, 뉴스, 커뮤니티 블로그).",
    "이 자료만 보고 담당자가 '이 키워드로 원고를 써도 될지' 30초 안에 판단할 수 있는 요약을 작성하라.",
    "",
    context,
    "",
    "----- 수집된 근거 -----",
    factCard,
    "-----------------------",
    "",
    "작성 규칙:",
    "- 한국어, 최대 8줄(불릿 -로 시작하는 줄)",
    "- 핵심 사실(일정/기간/가격/신청방법/장소 등)을 먼저 정리한다",
    `- 근거 안에 오늘(${today}) 기준으로 이미 지난 마감일·종료된 접수·마감된 예매·이미 발표된 ` +
      "당첨자 발표 등이 있으면 반드시 첫 줄에 '⚠️'로 시작해 명시한다 - 검색량이 높아도 이미 끝난 " +
      "이벤트라면 원고를 쓸 가치가 없을 수 있다",
    "- 근거 안의 날짜들이 서로 다르면(예: 페이지마다 다른 기간) 그 사실도 명시한다",
    "- 공공/의료 출처 없이 커뮤니티 발췌에만 있는 내용은 '커뮤니티에서만 확인됨'이라고 표시한다",
    "- 근거가 부실하거나(대부분 미분류·저신뢰) 키워드와 무관해 보이면 그 사실도 명시한다",
    "- 불릿(-)만 사용한다. 번호, 굵게(**), 제목(##), 머리말, 맺음말을 쓰지 않는다",
    "- 요약 내용만 출력한다. '다음은 요약입니다' 같은 설명을 붙이지 않는다",
  ].join("\n");
}

/**
 * 요약을 만든다. 실패해도 예외를 던지지 않는다 - 요약은 미리보기를 "더 읽기 쉽게" 하는 부가
 * 기능이지 체크포인트 자체의 필수 단계가 아니다. 실패하면 호출자가 폴백 표시를 할 수 있게
 * error를 돌려준다.
 */
export async function summarizeResearchForReview(
  input: SummarizeResearchInput,
  options: SummarizeResearchOptions = {}
): Promise<SummarizeResearchResult> {
  const startedAt = Date.now();

  if (input.sources.length === 0) {
    return {
      ok: true,
      summary: "- 수집된 근거가 없습니다. 원고를 쓰더라도 확인되지 않은 내용을 단정할 수 없습니다.",
      durationMs: Date.now() - startedAt,
    };
  }

  const generate =
    options.generateSummary ??
    ((prompt: string) => runHeadlessClaude({ prompt, timeoutMs: SUMMARIZE_RESEARCH_TIMEOUT_MS }));

  const result = await generate(buildPrompt(input));
  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    return { ok: false, error: result.error, durationMs };
  }

  const summary = result.output.trim();
  if (!summary) {
    return { ok: false, error: "요약 생성 결과가 비어 있습니다.", durationMs };
  }

  return { ok: true, summary, durationMs };
}
