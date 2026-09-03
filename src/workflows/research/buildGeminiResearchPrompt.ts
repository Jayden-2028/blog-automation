// Gemini에게 넘길 자료조사 프롬프트. buildResearchPrompt.ts(Claude용)와 목적은 같지만
// 구조가 다르다: Gemini는 Read/Write 도구가 없으므로 (a) researcher.md 전문을 Node가 직접
// 읽어 프롬프트에 그대로 인라인하고, (b) 파일 저장 대신 완성된 markdown 텍스트만 응답하라고
// 지시한다. 저장은 호출자(runArticleJob.ts)가 응답 텍스트를 받아 직접 한다.
//
// 규격(researcher.md)은 provider 중립적으로 쓰여 있어(작업 규칙일 뿐 "Claude가"라는 표현이
// 없다) 그대로 재사용할 수 있다 - 이 파일이 다루는 건 "규격을 어떻게 전달하는가"의 차이뿐이다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ArticleJobRow, SourceInsert } from "../../types/database.js";
import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";

const RESEARCHER_SPEC_PATH = resolve(PIPELINE_ROOT, "prompts/research/researcher.md");

export type BuildGeminiResearchPromptInput = {
  job: Pick<ArticleJobRow, "keyword" | "headline" | "category">;
  baselineSources: SourceInsert[];
  today: string;
};

/** researcher.md 전문을 읽는다. 못 읽으면 호출자가 그대로 예외를 받아 job을 failed로 남긴다. */
export function readResearcherSpec(): string {
  return readFileSync(RESEARCHER_SPEC_PATH, "utf8");
}

export function buildGeminiResearchPrompt(
  input: BuildGeminiResearchPromptInput,
  researcherSpec: string = readResearcherSpec()
): string {
  const { job, baselineSources, today } = input;

  const baselineLines =
    baselineSources.length === 0
      ? ["(없음 - NAVER 검색이 비었거나 실패했다. 전부 직접 검색해야 한다.)"]
      : baselineSources.map((s, i) => {
          const auth = s.authority ?? "미분류";
          const url = s.url ?? "(URL 없음)";
          return `${i + 1}. [${auth}] ${s.title ?? "(제목 없음)"} — ${url}`;
        });

  return [
    "너는 블로그 원고용 자료조사 담당자다. 아래는 이 작업의 전체 규격 문서(researcher.md) 원문이다.",
    "이 문서에 적힌 계약을 그대로 따른다. 아래 규격 문서와 그 뒤의 '파이프라인 오버라이드'가",
    "충돌하면 오버라이드가 우선한다.",
    "",
    "===== 규격 문서 시작 (prompts/research/researcher.md) =====",
    researcherSpec,
    "===== 규격 문서 끝 =====",
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}   (이 문자열을 다듬거나 바꾸지 않는다)`,
    job.category ? `- topic: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- notes: 원문 제목 "${job.headline}" 맥락 참고` : null,
    `- 오늘 날짜: ${today}`,
    "",
    "이미 수집된 기준 자료(baseline - NAVER 뉴스/웹/블로그 검색 결과):",
    ...baselineLines,
    "",
    "파이프라인 오버라이드(researcher.md와 충돌하면 이 지시가 우선한다):",
    "- 너에게는 Read/Write 도구가 없다. 규격 전문은 이미 위에 실려 있으니 그것만 따르고,",
    "  파일 경로·저장·충돌 규칙(§7의 '이미 있으면 -날짜를 붙인다' 등)은 전부 무시한다.",
    "  파일을 저장하는 주체는 네가 아니라 호출자다.",
    "- 근거 수집은 함께 제공된 구글 검색 도구로 한다. 검색 결과에 실제로 나온 내용만 쓰고,",
    "  §2 절대 규칙(추측 금지, 모든 문장에 출처 URL, 등급 숨기지 않기)을 그대로 지킨다.",
    "- 위 baseline 자료는 이미 확보된 것이다. 검색은 baseline이 못 채운 빈칸",
    "  (정의·핵심 수치·시행 이력·예외·자주 묻는 질문·오해)을 보강하는 데 집중한다.",
    "- §4의 7개 카테고리를 baseline 위에서 빠짐없이 시도한다. 각도를 바꿔 최소 3회 검색한다.",
    "- frontmatter의 keyword는 위 입력 keyword와 한 글자도 다르지 않아야 한다.",
    "- §10 전체 출처 목록 표에는 baseline + 네가 새로 찾은 URL을 전부 등급과 함께 넣는다(감사기록).",
    "",
    "출력 형식(반드시 지킬 것):",
    "- 완성된 markdown 파일 내용만 출력한다. 첫 글자부터 `---`(frontmatter 시작)여야 한다.",
    "- 코드블록(```)으로 감싸지 않는다.",
    "- 앞뒤로 인사말, '알겠습니다', 설명 문장을 절대 붙이지 않는다. §7 템플릿 그대로 끝까지 쓰고 멈춘다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
