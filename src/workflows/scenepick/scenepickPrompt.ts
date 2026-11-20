// Codex 주문서(stdin 프롬프트, 2026-11-21). **짧게 둔다** - 상시 지침(문체·이미지 규칙·납품 규격)은 작업장 루트의
// AGENTS.md(저장소 codex/scenepick/AGENTS.md를 매번 복사)에 있고 Codex가 스스로 읽는다. 주문서는 "이번 발주"만 담는다:
// job id, 주제 원문, 납품 폴더, 오늘 날짜(KST), 카테고리 목록.
//
// 납품 규격을 여기에 다시 적지 않는 이유: 두 군데 적으면 한쪽만 고쳐져 갈라진다. 우리 쪽 검사(validateScenepickDelivery)와
// AGENTS.md가 같은 규격을 말하고, 주문서는 그 파일을 가리키기만 한다.
import { SCENEPICK_CATEGORIES } from "./scenepickTypes.js";

export type ScenepickOrderInput = {
  jobId: string;
  /** 사용자가 사회 봇에 보낸 원문(metadata.inputTopic). */
  topic: string;
  /** 작업장 기준 상대 경로(jobs/<jobId>). */
  outputDir: string;
  /** KST YYYY-MM-DD. */
  today: string;
};

export function scenepickOutputDir(jobId: string): string {
  return `jobs/${jobId}`;
}

export function buildScenepickPrompt(input: ScenepickOrderInput): string {
  return [
    "# scenepick 원고 발주",
    "",
    `- job id: ${input.jobId}`,
    `- 오늘 날짜(KST): ${input.today}`,
    `- 납품 폴더: ${input.outputDir}/  (manuscript.md, meta.json, images/)`,
    `- 카테고리(하나 고른다): ${SCENEPICK_CATEGORIES.join(" | ")}`,
    "",
    "## 주제(사용자 원문)",
    "",
    input.topic.trim(),
    "",
    "## 지시",
    "",
    "작업장 루트의 AGENTS.md를 먼저 읽고, AGENTS.md의 납품 규격을 따른다.",
    "조사(웹 검색) → 원고 → 이미지 생성 → 납품 폴더에 저장 → 납품 전 점검표 확인까지 한 번에 끝낸다.",
    "납품 폴더 밖(package/, AGENTS.md 포함)의 파일은 만들거나 고치지 않는다.",
  ].join("\n");
}

/** 형식 검사에서 걸린 항목만 고쳐 다시 납품하라는 재작업 주문. AGENTS.md "재작업 주문" 절과 짝이다. */
export function buildScenepickFixPrompt(input: ScenepickOrderInput & { failures: readonly string[] }): string {
  return [
    "# scenepick 재작업 주문",
    "",
    `- job id: ${input.jobId}`,
    `- 오늘 날짜(KST): ${input.today}`,
    `- 납품 폴더: ${input.outputDir}/`,
    "",
    "앞선 납품이 형식 검사를 통과하지 못했다. **이 항목만 고쳐서 다시 납품**한다. 나머지는 건드리지 않는다.",
    "",
    ...input.failures.map((failure) => `- ${failure}`),
    "",
    "AGENTS.md의 납품 규격을 따른다. 원고·이미지가 아예 없으면 처음부터 만든다(주제는 아래).",
    "",
    "## 주제(사용자 원문)",
    "",
    input.topic.trim(),
  ].join("\n");
}
