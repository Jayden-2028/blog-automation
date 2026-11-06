// 보충 조사 결과를 조사 기록(`job.metadata.researchFileContent`)에 **덧붙인다**(2026-11-06).
//
// 왜 덧붙이기만 하는가: 원 조사가 감사 기록이다. 어떤 문장이 어디서 왔는지 되짚으려면 "처음 조사가
// 무엇을 알아냈는가"가 그대로 남아 있어야 한다. 보충분은 언제·왜·무엇을 더 조사했는지 적힌 블록으로
// 뒤에 붙고, 여러 번 수정하면 블록이 여러 개 쌓인다(각 블록이 그 수정 한 번의 기록이다).
//
// 순수 함수다 - DB·네트워크 없음. 저장은 호출부(reviseWithSupplementalResearch)가 한다.

import type { SupplementFinding, SupplementMissing, SupplementSource } from "./collectSupplementalResearch.js";

/** 보충 블록의 머리글. 조사 기록을 읽는 사람·에이전트가 원 조사와 바로 가를 수 있어야 한다. */
export const SUPPLEMENT_SECTION_HEADER = "## 보충 조사 (수정 요청 반영)";

export type SupplementBlockInput = {
  /** 사용자가 보낸 수정 요청 원문. "왜 더 조사했는가"가 이것이다. */
  feedback: string;
  /** 조사 범위로 확정한 항목 전부. */
  items: readonly string[];
  packFindings: readonly SupplementFinding[];
  agentFindings: readonly SupplementFinding[];
  missing: readonly SupplementMissing[];
  sources: readonly SupplementSource[];
  /** 기록 시각(ISO). */
  at: string;
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 보충 조사 한 번을 조사 기록에 붙일 마크다운 블록으로 만든다. */
export function buildSupplementBlock(input: SupplementBlockInput): string {
  const lines: string[] = [
    "",
    "---",
    "",
    `${SUPPLEMENT_SECTION_HEADER} — ${input.at}`,
    "",
    `- 왜: 사용자 수정 요청 "${oneLine(input.feedback)}"`,
    `- 무엇: ${input.items.join(" / ")}`,
    `- 원 조사는 위에 그대로 있다(이 블록은 덧붙인 것이다).`,
    "",
  ];

  for (const finding of input.packFindings) {
    lines.push(`### 보충 · ${finding.item} (출처: 인물 소스팩 - 네이버 인물DB·나무위키)`, "", finding.body.trim(), "");
  }
  for (const finding of input.agentFindings) {
    lines.push(`### 보충 · ${finding.item} (출처: 보충 조사 - 웹)`, "", finding.body.trim(), "");
  }

  if (input.sources.length > 0) {
    lines.push("### 보충 출처", "", "| 제목 | URL | 등급 | 발행일 |", "| --- | --- | --- | --- |");
    for (const source of input.sources) {
      lines.push(`| ${oneLine(source.title)} | ${source.url} | ${source.authority} | ${source.publishedAt ?? "-"} |`);
    }
    lines.push("");
  }

  if (input.missing.length > 0) {
    lines.push("### 못 찾은 항목 (본문에 쓰지 않는다)", "");
    for (const entry of input.missing) lines.push(`- ${entry.item}: ${oneLine(entry.reason)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 조사 기록 뒤에 보충 블록을 붙인다. 기존 내용은 한 글자도 바꾸지 않는다.
 * 조사 기록이 아예 없던 job(옛 job)도 빈 문자열에서 시작해 블록만 남긴다.
 */
export function appendSupplementalResearch(researchText: string | null, block: string): string {
  const base = (researchText ?? "").replace(/\s+$/, "");
  return base ? `${base}\n${block}` : block.replace(/^\s*\n+/, "");
}

/** 조사 기록에 붙어 있는 보충 블록 수. 덧붙이기가 덮어쓰기로 바뀌지 않았는지 테스트가 이걸로 단정한다. */
export function countSupplementBlocks(researchText: string | null): number {
  if (!researchText) return 0;
  return researchText.split(SUPPLEMENT_SECTION_HEADER).length - 1;
}
