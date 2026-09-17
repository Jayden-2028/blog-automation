// 헤드리스 researcher 에이전트에게 넘길 프롬프트.
//
// Node는 조율만 한다(CLAUDE.md 원고 파이프라인 운영 규칙): 규격은 prompts/research/researcher.md,
// 이 함수는 그 규격을 "읽고 따르라"고 지시하고 job 컨텍스트 + baseline 자료 + 정확한 출력 경로만
// 박아 넣는다. 조사 방법·품질 기준·파일 템플릿은 전부 researcher.md에 있다.

import type { ArticleJobRow, SourceInsert } from "../../types/database.js";
import { formatBriefForPrompt } from "../brief/buildKeywordBrief.js";
import type { KeywordBrief } from "../brief/buildKeywordBrief.js";

export type BuildResearchPromptInput = {
  job: Pick<ArticleJobRow, "keyword" | "headline" | "category">;
  /**
   * 기획 브리프(2026-09-17). 있으면 researcher는 여기 적힌 독자 질문에 답할 자료를 1순위로 찾고,
   * 키워드 유형에 맞는 소스 프로파일(researcher.md §4-1)을 쓴다. 브리프 생성이 실패하면 null이고
   * 그때는 예전처럼 researcher.md 기본 절차로 돈다 - 브리프가 원고 생성을 막지 않는다.
   */
  brief?: KeywordBrief | null;
  /** Node가 NAVER API로 먼저 모은 기준 자료. 에이전트는 이 위에 빈칸만 보강한다(하이브리드). */
  baselineSources: SourceInsert[];
  /** 에이전트가 정확히 여기에 Write해야 한다(절대 경로). */
  outputPath: string;
  today: string;
};

export function buildResearchPrompt(input: BuildResearchPromptInput): string {
  const { job, baselineSources, outputPath, today } = input;

  const baselineLines =
    baselineSources.length === 0
      ? ["(없음 - NAVER 검색이 비었거나 실패했다. 전부 직접 조사해야 한다.)"]
      : baselineSources.map((s, i) => {
          const auth = s.authority ?? "미분류";
          const url = s.url ?? "(URL 없음)";
          return `${i + 1}. [${auth}] ${s.title ?? "(제목 없음)"} — ${url}`;
        });

  return [
    "너는 블로그 원고용 자료조사 에이전트다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격을 못 읽으면 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/research/researcher.md  (자료조사 계약서 - 절대 규칙, 등급, 수집 절차, 검증, 출력 템플릿)",
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
    ...(input.brief
      ? [
          "기획 브리프(이 키워드를 검색한 독자가 알고 싶은 것 - researcher.md §4-1·§6-1이 이걸 소비한다):",
          formatBriefForPrompt(input.brief),
          "",
        ]
      : []),
    "파이프라인 오버라이드(researcher.md와 충돌하면 이 지시가 우선):",
    ...(input.brief
      ? [
          `- 수집 순서는 researcher.md §4 기본 표 대신 §4-1의 \`${input.brief.type}\` 프로파일을 따른다.`,
          "- §6-1대로 브리프의 질문 Q1~Q5 각각에 답할 자료를 먼저 찾고, 답을 못 찾은 질문은 §7 확인 실패에",
          "  \"Q{n} 미해결: <무엇을 찾아봤는지>\"로 남긴다. 질문을 건너뛰거나 다른 질문으로 바꾸지 않는다.",
        ]
      : []),
    `- 출력 파일은 researcher.md §7의 이름 규칙·충돌 규칙을 무시하고 정확히 이 절대 경로에 Write한다: ${outputPath}`,
    "- 위 baseline 자료는 이미 확보된 것이다. 그 URL들을 다시 열어 확인하되, 조사는 baseline이 못",
    "  채운 빈칸(정의·핵심 수치·시행 이력·예외·자주 묻는 질문·오해)을 WebSearch/WebFetch로 보강하는 데 집중한다.",
    "- researcher.md §4의 7개 카테고리를 baseline 위에서 빠짐없이 시도한다. 각도를 바꿔 최소 3회 검색한다.",
    "- frontmatter의 keyword는 위 입력 keyword와 한 글자도 다르지 않아야 한다.",
    "- §10 전체 출처 목록 표에는 baseline + 네가 새로 연 URL을 전부 등급과 함께 넣는다(감사기록).",
    "",
    "완료하면 파일을 저장한 뒤 마지막 줄에 `SAVED: <경로>`만 답하라. 다른 설명은 필요 없다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
