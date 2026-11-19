// 인물 제미나이 그림자 트랙의 프롬프트 두 개. **의도적으로 zero-base다.**
//
// ⚠️ 이 파일은 저장소의 어떤 작성 규격도 import하거나 인라인하지 않는다 - prompts/research/researcher.md,
// prompts/writing/writer.md, core-rules.md, style/*.md, rules/*.md, docs/seo-guide.md, 금지 표현 목록,
// 분량·구조·어투 지침 전부. 이 트랙의 존재 이유가 "우리 규칙 없이 Gemini가 혼자 쓰면 어떤 글이 나오는가"를
// 기존 파이프라인과 비교하는 것이기 때문이다. 규칙을 한 줄이라도 넣으면 비교가 오염된다.
// (testGeminiPerson.ts가 규격 파일의 고유 문구가 프롬프트에 섞이지 않았는지 대조한다.)
//
// 호출 둘 모두 "무엇을 할지"만 말한다. 쓰는 방법(구조·길이·어조·이미지)은 모델이 정한다.
// 유일한 제약은 파싱용 출력 약속 하나: 첫 줄 `# 제목`, 그 아래 마크다운 본문.

export type GeminiPersonSubject = {
  /** 인물 이름(job.keyword). */
  name: string;
  /** 글을 요청한 쪽이 남긴 설명(핫이슈 스타의 배경 한 줄, 인스타 캡션 등). 없으면 null. */
  requestNote: string | null;
};

/** 요청 설명은 길어질 수 있어 상한을 둔다(인스타 캡션이 수천 자인 적이 있다). */
const REQUEST_NOTE_LIMIT = 1_500;

function noteLine(note: string | null): string {
  const trimmed = (note ?? "").trim();
  if (!trimmed) return "";
  const clipped = trimmed.length > REQUEST_NOTE_LIMIT ? `${trimmed.slice(0, REQUEST_NOTE_LIMIT)}...` : trimmed;
  return `\n글을 요청한 쪽이 남긴 설명은 다음과 같다.\n${clipped}\n`;
}

/** 호출 1(조사, google_search grounding). */
export function buildGeminiPersonResearchPrompt(subject: GeminiPersonSubject): string {
  return [
    `이 인물에 대한 네이버 블로그 글을 쓰려 한다. 대상 인물은 "${subject.name}"이다.${noteLine(subject.requestNote)}`,
    "필요한 자료를 직접 판단해 조사하고 정리하라. 출처 URL을 남겨라.",
  ].join("\n");
}

/** 발행본 예시 한 편(제목 + 본문). geminiPersonExamples.ts가 네이버에서 읽어 온다. */
export type GeminiPersonExample = { title: string; body: string };

/**
 * 호출 2(집필). 조사 노트를 그대로 건넨다. 2026-11-19부터 **이 블로그의 발행본 예시**를 함께 보여 준다
 * (사용자 결정). 예시는 문체·구성 참고용이고 사실은 조사 자료를 따르게 한다. 예시가 없으면 옛 zero-base와 같다.
 */
export function buildGeminiPersonWritePrompt(
  subject: GeminiPersonSubject,
  researchNotes: string,
  examples: readonly GeminiPersonExample[] = []
): string {
  const exampleBlock =
    examples.length === 0
      ? []
      : [
          "",
          `아래는 이 블로그에 실제로 발행된 인물 글 ${examples.length}편이다. 이 블로그의 글이 어떤 문체와 구성으로 쓰이는지 참고하라.`,
          "다만 다른 인물의 글이니 내용(사실·작품·수치)은 가져오지 말고, 사실은 아래 조사 자료만 따른다.",
          ...examples.flatMap((ex, i) => ["", `[발행본 예시 ${i + 1}]`, ex.title ? `제목: ${ex.title}` : "", ex.body].filter((line) => line !== "")),
        ];
  return [
    `아래는 "${subject.name}"에 대해 조사한 자료다. 이 자료를 바탕으로 이 인물에 대한 한국어 네이버 블로그 글을 써라.${noteLine(subject.requestNote)}`,
    "글의 구성, 분량, 어조는 네가 판단해서 정한다.",
    "",
    "출력 형식은 이것만 지켜라. 첫 줄은 `# 제목`이고, 그 아래부터 마크다운 본문이다. 그 밖의 설명이나 인사말은 붙이지 마라.",
    ...exampleBlock,
    "",
    "[조사 자료]",
    researchNotes,
  ].join("\n");
}
