// research/[키워드].md(researcher.md §7 규격)를 사람이 30초 안에 "이 키워드로 원고를 써도 될지"
// 판단할 수 있는 짧은 Telegram 요약으로 옮긴다. runResearchStage 직후 notifyResearchReady가 호출한다.
//
// 2026-09-01 재작성: 예전에는 sources를 헤드리스 claude에 넘겨 요약을 "생성"했다(비용·수십 초).
// 이제 researcher 에이전트가 이미 §1 요약을 파일에 써 두므로 그걸 그대로 옮기고, verdict만
// 덧붙인다 - LLM 호출 없음, 결정적.

import { parseResearchFile } from "./parseResearchFile.js";
import type { ParsedResearchFile, ResearchVerdict } from "./parseResearchFile.js";

const VERDICT_LINE: Record<ResearchVerdict, string> = {
  ok: "✅ 근거 충분 (verdict: ok)",
  thin: "⚠️ 근거 얇음 - 사람 검토 후 진행 판단 (verdict: thin)",
  blocked: "⛔ 근거 부족 - 원고 생성 보류 (verdict: blocked)",
};

export type ResearchSummary = {
  verdict: ResearchVerdict;
  /** Telegram 본문에 그대로 넣을 여러 줄 텍스트(마크다운 강조 없음). */
  text: string;
};

/**
 * 이미 파싱된 research 파일을 요약 텍스트로 만든다. 근거 판단(verdict)과 §1 요약만 남긴다 -
 * 출처 건수(등급별 breakdown)는 헤더의 sourceCounts와 사실상 중복이었고(2026-09-04, 두 계산이
 * 서로 다른 값을 낸 것까지 실측에서 확인됨), 확인되지 않은 통설 블록은 메시지를 너무 길게 만들어
 * 뺐다 - 근거 상세가 필요하면 research/[키워드].md 원본을 직접 연다.
 */
export function buildResearchSummary(parsed: ParsedResearchFile): ResearchSummary {
  const lines: string[] = [VERDICT_LINE[parsed.verdict]];

  if (parsed.summary) {
    lines.push("", parsed.summary.trim());
  }

  return { verdict: parsed.verdict, text: lines.join("\n") };
}

/** research 파일 텍스트에서 바로 요약을 만든다. 파싱 실패해도 예외를 던지지 않는다. */
export function summarizeResearchFile(fileText: string): ResearchSummary {
  return buildResearchSummary(parseResearchFile(fileText));
}
