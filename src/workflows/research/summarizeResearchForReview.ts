// research/[키워드].md(researcher.md §7 규격)를 사람이 30초 안에 "이 키워드로 원고를 써도 될지"
// 판단할 수 있는 짧은 Telegram 요약으로 옮긴다. runResearchStage 직후 notifyResearchReady가 호출한다.
//
// 2026-09-01 재작성: 예전에는 sources를 헤드리스 claude에 넘겨 요약을 "생성"했다(비용·수십 초).
// 이제 researcher 에이전트가 이미 §1 요약을 파일에 써 두므로 그걸 그대로 옮기고, verdict·출처
// 구성·확인되지 않은 통설 경고만 덧붙인다 - LLM 호출 없음, 결정적.

import { parseResearchFile } from "./parseResearchFile.js";
import type { ParsedResearchFile, ResearchVerdict } from "./parseResearchFile.js";
import type { SourceAuthorityLevel } from "../../types/database.js";

const VERDICT_LINE: Record<ResearchVerdict, string> = {
  ok: "✅ 근거 충분 (verdict: ok)",
  thin: "⚠️ 근거 얇음 - 사람 검토 후 진행 판단 (verdict: thin)",
  blocked: "⛔ 근거 부족 - 원고 생성 보류 (verdict: blocked)",
};

function sourceCountLine(counts: Record<SourceAuthorityLevel, number>): string {
  const total = counts.official + counts.medical + counts.news + counts.community;
  return `근거 ${total}건 — 공공 ${counts.official} · 의료 ${counts.medical} · 뉴스 ${counts.news} · 커뮤니티 ${counts.community}`;
}

export type ResearchSummary = {
  verdict: ResearchVerdict;
  /** Telegram 본문에 그대로 넣을 여러 줄 텍스트(마크다운 강조 없음). */
  text: string;
};

/** 이미 파싱된 research 파일을 요약 텍스트로 만든다. */
export function buildResearchSummary(parsed: ParsedResearchFile): ResearchSummary {
  const lines: string[] = [VERDICT_LINE[parsed.verdict], "", sourceCountLine(parsed.sourceCounts)];

  if (parsed.summary) {
    lines.push("", parsed.summary.trim());
  }

  if (parsed.unverifiedClaims.length > 0) {
    lines.push("", "⚠️ 확인되지 않은 통설(커뮤니티만 확인 - 사실로 단정 금지):");
    for (const claim of parsed.unverifiedClaims.slice(0, 4)) {
      lines.push(`- ${claim}`);
    }
  }

  return { verdict: parsed.verdict, text: lines.join("\n") };
}

/** research 파일 텍스트에서 바로 요약을 만든다. 파싱 실패해도 예외를 던지지 않는다. */
export function summarizeResearchFile(fileText: string): ResearchSummary {
  return buildResearchSummary(parseResearchFile(fileText));
}
