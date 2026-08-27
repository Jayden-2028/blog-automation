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
    "출력 형식 예시(빈 줄로 구간을 나누고, 사실 항목은 불릿 -로 나열한다):",
    "⚠️ 우선 예매(추첨) 접수·당첨자 발표는 이미 끝남",
    "",
    "- 일정: 9/2~10/24, 수~일 운영",
    "- 가격: 1인 6만원",
    "- 신청: 8/28 14:00부터 잔여석 선착순(티켓링크)",
    "",
    "판단: 잔여석 선착순 예매와 행사 자체가 아직 남아 있어 '잔여석 안내·관람 후기' 각도로는 원고 가치 있음",
    "",
    "작성 규칙:",
    "- 한국어, 전체 8줄을 넘기지 않는다(경고 1줄 + 사실 항목 + 판단 1줄)",
    "- 구조는 정확히 3구간: [⚠️ 경고(있을 때만), 빈 줄] -> [불릿(-) 사실 항목들, 빈 줄] -> [판단: 한 줄]",
    "- 사실 항목 순서: 일정 -> 가격 -> 신청/예매방법 -> 대상 -> 장소 -> 유의. 있는 정보만 쓰고 없는 항목은 만들지 않는다",
    "- 사실 항목은 한 줄에 한 문장, 한 절만 담는다. 괄호 설명을 여러 개 겹쳐 달지 않는다",
    `- 오늘(${today}) 기준으로 이미 지난 마감일·종료된 접수·마감된 예매·이미 발표된 당첨자 등이 ` +
      "있으면 맨 윗줄에 '⚠️'로 시작하는 한 문장짜리 경고를 쓴다 - 상세 날짜는 '일정' 항목에 쓰고 " +
      "경고 줄에서 다시 설명하지 않는다(중복 금지)",
    "- '판단:' 줄은 반드시 정확히 한 줄 쓴다: 이 키워드가 원고로 쓸 가치가 있는지, 있다면 어떤 각도로 " +
      "써야 하는지(예: 아직 예매 전이면 그대로 안내, 이미 마감이어도 잔여석·후기·다음 회차 안내 " +
      "각도가 남아 있으면 그 각도를, 정말 쓸 가치가 없으면 그것도 명시)를 한 문장으로 판단한다",
    "- '근거 1은', '근거 4에서 확인' 같은 출처 번호를 절대 언급하지 않는다 - 이 번호는 읽는 사람에게 안 보인다",
    "- 근거끼리 날짜/조건이 서로 다르면 '유의: ...' 항목으로만 짧게 표시한다(길게 풀어 설명하지 않는다)",
    "- 공공/의료 출처 없이 커뮤니티에만 있는 내용은 해당 줄 끝에 '(커뮤니티만 확인)'만 붙인다",
    "- 근거가 부실하거나 키워드와 무관해 보이면 '유의: 근거 부족' 항목과 그에 맞는 판단을 쓴다",
    "- 사실 항목의 불릿(-) 외에는 마크다운 강조(**, ##)나 번호를 쓰지 않는다",
    "- 위 3구간 내용만 출력한다. '다음은 요약입니다' 같은 머리말/맺음말을 붙이지 않는다",
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
