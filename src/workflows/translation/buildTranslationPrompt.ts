// 한→영 번역 프롬프트 조립(개편3 §4.3-2).
//
// 두 층이다:
//   1) 번역·현지화 **지침**(문체·로마자 표기·독자 가정) - `prompts/translation/kscene-ko-en.md`. 기획 세션(⑤)이 설계한
//      본문으로 통째로 교체할 수 있다. 코드는 이 파일의 내용만 읽어 넣는다.
//   2) **계약**(출력 구분자·이미지 마커 보존·링크 보존·한글 대역 요약) - 이 파일이 덧붙인다. 지침을 교체해도 파이프라인이
//      기대하는 형식은 깨지지 않는다(parseTranslationOutput.ts가 같은 계약을 검증한다).
//
// 모델에게 도구를 주지 않는다(순수 텍스트 변환). 입력은 전부 프롬프트에 실어 보내고, 출력은 stdout으로 받는다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";

/** 번역·현지화 지침 파일(저장소 루트 기준). 교체 지점이다. */
export const TRANSLATION_GUIDE_PATH = "prompts/translation/kscene-ko-en.md";

export type BuildTranslationPromptInput = {
  keyword: string;
  koreanTitle: string;
  koreanSearchDescription: string | null;
  /** 한글 원고 본문(참고 자료 포함, 끝 해시태그 줄 제외). */
  koreanBody: string;
  koreanTags: string[];
  /** 영어본 재승인 단계의 "수정 필요" 답장. 있으면 직전 영어본을 이 방향으로 고친다. */
  feedback?: string | null;
  /** 직전 영어본 본문(feedback과 함께 올 때만). */
  previousEnglishBody?: string | null;
  /** 직전 시도의 검증 오류(자동 재시도). */
  retryErrors?: readonly string[] | null;
  /** 지침 본문 주입(테스트). 생략하면 TRANSLATION_GUIDE_PATH를 읽는다. */
  guide?: string;
};

export function loadTranslationGuide(): string {
  return readFileSync(resolve(PIPELINE_ROOT, TRANSLATION_GUIDE_PATH), "utf8").trim();
}

export function buildTranslationPrompt(input: BuildTranslationPromptInput): string {
  const guide = input.guide ?? loadTranslationGuide();

  return [
    "너는 한국어 원고를 영어 블로그용 글로 번역·현지화하는 편집자다. 도구를 쓰지 않고 아래 입력만으로 작업한다.",
    "",
    "=== 번역·현지화 지침 ===",
    guide,
    "",
    "=== 출력 계약(지침보다 우선) ===",
    "아래 구분자를 **정확히 이 순서·이 표기로** 쓰고, 구분자 줄에는 다른 글자를 붙이지 않는다. 구분자 밖에는 아무것도 쓰지 않는다.",
    "",
    "<<<TITLE>>>",
    "(영어 제목 한 줄. 마크다운 기호 없이)",
    "<<<SEARCH_DESCRIPTION>>>",
    "(영어 검색 설명 한 줄, 150자 이내. 본문에 있는 내용만)",
    "<<<SLUG>>>",
    "(영문 소문자 kebab-case 퍼머링크 후보, 3~8단어)",
    "<<<TAGS>>>",
    "(영어 태그 5~10개, 쉼표로 구분, # 없이)",
    "<<<BODY>>>",
    "(영어 본문 전체. 마크다운)",
    "<<<KO_SUMMARY>>>",
    "(영어 본문의 문단별 요지를 **한국어**로, `- `로 시작하는 한 줄씩. 영어 본문의 문단 순서 그대로. 번역이 아니라 요지다)",
    "<<<END>>>",
    "",
    "본문(BODY) 규칙:",
    "- 한글 원고의 구조(소제목 순서, 목록, 문단 구분)를 그대로 유지한다. 소제목은 `**볼드**` 한 줄 규격을 쓴다.",
    "- **`[IMAGE: 설명 — 획득 방식]` 마커는 개수와 순서를 한 개도 바꾸지 않는다.** 마커를 추가·삭제·병합·재배열하지 않는다.",
    "  설명 부분만 영어로 쓰고(독자에게 보일 캡션·alt 텍스트다), 끝의 `— 웹 검색`/`— AI 생성`/`— 페이지 캡처`/",
    "  `— 인포그래픽 생성` 접미사는 **한글 그대로** 남긴다. 접미사가 바뀌면 이미지를 구하는 방식이 바뀐다.",
    "- 마크다운 링크 `[텍스트](URL)`의 URL은 한 글자도 바꾸지 않는다. 한국어 설명형 링크 텍스트만 영어로 옮기고 고유명사는 그대로 둔다.",
    "- `참고 자료` 소제목은 `**References**`로 옮긴다.",
    "- 한글 원고에 없는 사실·수치·링크를 만들지 않는다. 영어 본문에 한글을 남기지 않는다(괄호 안의 표지판·메뉴 표기, 마커 접미사만 예외).",
    "",
    "=== 입력 ===",
    `- keyword: ${input.keyword}`,
    `- 한글 제목: ${input.koreanTitle}`,
    input.koreanSearchDescription ? `- 한글 검색 설명: ${input.koreanSearchDescription}` : null,
    input.koreanTags.length > 0 ? `- 한글 태그: ${input.koreanTags.join(", ")}` : null,
    "",
    "한글 원고 본문:",
    "<<<KOREAN_BODY",
    input.koreanBody,
    "KOREAN_BODY>>>",
    ...(input.feedback
      ? [
          "",
          "=== 수정 요청(영어본 재승인 단계에서 사용자가 보낸 방향) ===",
          input.feedback,
          input.previousEnglishBody
            ? `\n직전 영어본(이 방향대로 고친다. 사실은 한글 원고가 기준이다):\n<<<PREVIOUS_ENGLISH\n${input.previousEnglishBody}\nPREVIOUS_ENGLISH>>>`
            : null,
        ]
      : []),
    ...(input.retryErrors && input.retryErrors.length > 0
      ? [
          "",
          "=== 직전 시도가 계약을 어겨 다시 요청한다 ===",
          ...input.retryErrors.map((error) => `- ${error}`),
          "위 문제를 고쳐 **처음부터 전체를 다시** 출력한다.",
        ]
      : []),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
