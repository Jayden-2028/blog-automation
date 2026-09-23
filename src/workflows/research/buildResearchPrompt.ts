// 헤드리스 researcher 에이전트에게 넘길 프롬프트.
//
// Node는 조율만 한다(CLAUDE.md 원고 파이프라인 운영 규칙): 규격은 prompts/research/researcher.md,
// 이 함수는 그 규격을 "읽고 따르라"고 지시하고 job 컨텍스트 + baseline 자료 + 정확한 출력 경로만
// 박아 넣는다. 조사 방법·품질 기준·파일 템플릿은 전부 researcher.md에 있다.

import type { ArticleJobRow, SourceInsert } from "../../types/database.js";
import { formatBriefForPrompt } from "../brief/buildKeywordBrief.js";
import type { KeywordBrief } from "../brief/buildKeywordBrief.js";
import { DEFAULT_WRITING_MODE } from "../../config/writingMode.js";
import type { WritingMode } from "../../config/writingMode.js";

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
  /**
   * 인스타그램 수동 큐레이션 job의 원본 자료(2026-09-21). 캡션 + 이미지에 번인된 텍스트.
   * 있으면 이게 이 job의 1차 근거다 - researcher.md의 일반 절차보다 우선해서 이 내용의 사실관계를
   * 검증·보강하는 데 조사를 집중시킨다. keyword는 NAVER baseline 검색용 짧은 문자열일 뿐이라
   * 이 원문이 없으면 무엇을 다루는 글인지 절반만 아는 셈이다.
   */
  sourceContext?: string | null;
  /**
   * 규격 모드(2026-09-23 검증). `auto`면 researcher.md 대신 researcher-auto.md를 읽히고
   * 브리프·수집 카테고리·필수 항목 지시를 전부 빼서 조사 범위를 에이전트가 정하게 한다.
   */
  mode?: WritingMode;
};

function formatBaseline(baselineSources: SourceInsert[]): string[] {
  if (baselineSources.length === 0) {
    return ["(없음 - NAVER 검색이 비었거나 실패했다. 전부 직접 조사해야 한다.)"];
  }
  return baselineSources.map((s, i) => {
    const auth = s.authority ?? "미분류";
    const url = s.url ?? "(URL 없음)";
    // 지식iN·카페·백과는 등급만으로는 구분이 안 된다(전부 community). 독자의 질문 원문이라 표시한다.
    const label =
      s.source_name === "naver_kin"
        ? " (지식iN 질문)"
        : s.source_name === "naver_cafe"
          ? " (카페 글)"
          : s.source_name === "naver_encyc"
            ? " (백과사전)"
            : "";
    return `${i + 1}. [${auth}]${label} ${s.title ?? "(제목 없음)"} — ${url}`;
  });
}

/**
 * 자율 모드 프롬프트(2026-09-23 검증).
 *
 * spec 모드와 다른 점: 브리프를 넘기지 않고, 수집 카테고리·유형 프로파일·필수 항목 목록을 주지
 * 않는다. 무엇을 찾을지는 에이전트가 정한다. 남기는 것은 코드가 파싱하는 세 블록(frontmatter /
 * 캡처할 페이지 / 전체 출처 목록)과 사실 규칙뿐이다.
 */
function buildAutoResearchPrompt(input: BuildResearchPromptInput): string {
  const { job, baselineSources, outputPath, today } = input;

  return [
    "너는 블로그 원고용 자료조사 에이전트다. 아래 규격을 Read로 읽고 그대로 따른다.",
    "규격을 못 읽으면 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/research/researcher-auto.md   (자율 모드 규격 - 짧다. 전부 읽어라)",
    "- prompts/writing/rules/topic-allocation.md   (주제 배분 - 조사 분량도 이 비율을 따른다)",
    "- prompts/writing/rules/article-structure.md  (카테고리별 문단 흐름 - 이 단계들을 채울 자료를 찾는다)",
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}   (이 문자열을 다듬거나 바꾸지 않는다)`,
    job.category ? `- 분류: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- 원문 기사 제목: ${job.headline}` : null,
    `- 오늘 날짜: ${today}`,
    "",
    "이미 수집된 기준 자료(baseline - NAVER 뉴스/웹/블로그 검색 결과):",
    ...formatBaseline(baselineSources),
    "",
    "파이프라인이 정하는 것(규격과 충돌하면 이쪽이 우선):",
    `- 출력 파일은 정확히 이 절대 경로에 Write한다: ${outputPath}`,
    "- frontmatter의 keyword는 위 입력 keyword와 한 글자도 다르지 않아야 한다.",
    "- `## 전체 출처 목록` 표에는 baseline + 네가 새로 연 URL을 전부 등급과 함께 넣는다(감사기록).",
    "- `## 캡처할 페이지`를 둔다(없으면 \"없음\"). 집필이 여기 적힌 URL만 캡처 자리에 쓴다.",
    "",
    "**조사 항목 목록은 주지 않는다. 무엇을 찾을지는 네가 정한다.**",
    "규격 §1대로 \"이 키워드를 검색한 사람은 ___을 알고 싶어 한다\"를 먼저 완성하고,",
    "그것을 확인하는 데 필요한 것을 네가 판단해서 찾아라. 실물이 있으면 실물을 직접 연다.",
    "",
    "완료하면 파일을 저장한 뒤 마지막 줄에 `SAVED: <경로>`만 답하라. 다른 설명은 필요 없다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildResearchPrompt(input: BuildResearchPromptInput): string {
  const { job, baselineSources, outputPath, today } = input;
  if ((input.mode ?? DEFAULT_WRITING_MODE) === "auto") return buildAutoResearchPrompt(input);

  const baselineLines = formatBaseline(baselineSources);

  return [
    "너는 블로그 원고용 자료조사 에이전트다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격을 못 읽으면 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/research/researcher.md  (자료조사 계약서 - 절대 규칙, 등급, 수집 절차, 검증, 출력 템플릿)",
    "- prompts/writing/rules/topic-allocation.md  (주제 배분 - 조사 분량도 이 비율을 따른다)",
    "- prompts/writing/rules/article-structure.md (카테고리별 문단 흐름 - 이 단계들을 채울 자료를 찾는다)",
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}   (이 문자열을 다듬거나 바꾸지 않는다)`,
    job.category ? `- topic: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- notes: 원문 제목 "${job.headline}" 맥락 참고` : null,
    `- 오늘 날짜: ${today}`,
    "",
    ...(input.sourceContext
      ? [
          "이 job의 원본 자료(사용자가 인스타그램에서 직접 골라 보낸 게시물 - 1차 근거, 조사로 걷어내지 않는다):",
          input.sourceContext,
          "",
          "위 원본 자료를 §2(확인된 사실)의 뼈대로 삼고, WebSearch/WebFetch는 이 내용의 사실관계 검증·",
          "배경 보강(왜 이 일이 생겼는지, 관련 인물·수치·이전 사례)에 집중한다. 원본에 없는 내용을",
          "지어내지 않는다 - 확인 안 되면 §7 확인 실패에 남긴다.",
          "",
        ]
      : []),
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
    "- baseline의 **(지식iN 질문)·(카페 글)** 항목은 §5 '사람들이 실제로 묻는 질문'의 원문이다. 그 제목을",
    "  그대로 §5에 옮긴다(URL 포함) - 이 항목이 있는데 §5를 '찾지 못함'으로 두지 않는다.",
    "- **§11 캡처할 페이지**를 반드시 채운다(없으면 \"없음\"). 이벤트·프로모션 안내, 공식 신청 페이지,",
    "  작품·상품 공식 소개, 순위·차트처럼 **그 화면을 보여주는 것이 답인** 페이지의 URL이다.",
    "  파이프라인이 이 주소를 그대로 열어 찍으므로 **직접 열어본 것만** 적는다 - 로그인해야 보이거나",
    "  앱에서만 열리는 화면은 적지 않는다(찍으면 로그인 벽이 찍힌다).",
    "- frontmatter의 keyword는 위 입력 keyword와 한 글자도 다르지 않아야 한다.",
    "- §10 전체 출처 목록 표에는 baseline + 네가 새로 연 URL을 전부 등급과 함께 넣는다(감사기록).",
    "",
    "완료하면 파일을 저장한 뒤 마지막 줄에 `SAVED: <경로>`만 답하라. 다른 설명은 필요 없다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
