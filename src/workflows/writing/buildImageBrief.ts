// 원고 승인 시 이미지 브리프를 만든다(SPRINT_3_DESIGN.md 9절).
//
// 왜 브리프만 만들고 이미지 자체는 만들지 않는가: 이 저장소에서 쓸 수 있는 ChatGPT 계열 도구는
// Codex CLI뿐인데 Codex는 코딩 에이전트라 이미지를 생성하지 못한다. 그래서 실제 흐름은 수동
// 핸드오프다 - Claude가 브리프(장면 설명 + ChatGPT에 그대로 붙여넣을 생성 프롬프트 + alt_text +
// 금지 항목)를 만들어 Telegram으로 보내고, 사용자가 ChatGPT에서 이미지를 확보한 뒤
// `npm run job:image`로 기록한다(recordArticleImage.ts).
//
// LLM을 쓰는 이유: "장면"은 원고 주제마다 달라야 의미가 있다(제목 생성과 같은 이유로 템플릿으로는
// 못 만든다). 생성 프롬프트는 실측 사례를 참고해 영어로 만든다(이미지 생성 모델이 영어 프롬프트에
// 더 안정적으로 반응하는 경향을 반영) - 나머지 필드는 한국어다.
//
// 금지 항목이 핵심이다(설계 §9-2, §10): "생성이 기본, 서치는 공식 보도자료·라이선스 스톡만"
// 결정에 따라, 실존 인물·브랜드 로고·실제 제품 사진처럼 저작권·초상권 위험이 있는 요소를 프롬프트
// 단계에서부터 명시적으로 배제한다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";

/** 브리프 생성은 짧은 텍스트 작업이라 원고 생성보다 훨씬 짧게 잡는다. */
export const IMAGE_BRIEF_TIMEOUT_MS = 90_000;

export const IMAGE_BRIEF_MARKERS = {
  scene: "### SCENE",
  prompt: "### PROMPT",
  altText: "### ALT_TEXT",
  prohibited: "### PROHIBITED",
} as const;

export type BuildImageBriefInput = {
  title: string;
  keyword: string;
  category: string | null;
  /** 있으면 장면 설명에 참고한다(요약이 원고 핵심을 짧게 담고 있다). */
  seoDescription?: string | null;
};

export type ImageBriefOptions = {
  /** 테스트에서 실제 LLM 호출을 대체하는 주입 지점. */
  generateBrief?: (prompt: string) => Promise<{ ok: true; output: string } | { ok: false; error: string }>;
};

export type ParsedImageBrief = {
  scene: string;
  /** ChatGPT에 그대로 붙여넣을 영어 생성 프롬프트. */
  prompt: string;
  altText: string;
  /** 왜 이 목록인지는 모듈 상단 주석 참고. */
  prohibited: string;
};

export type BuildImageBriefResult =
  | { ok: true; brief: ParsedImageBrief; durationMs: number }
  | { ok: false; error: string; durationMs: number };

function buildPrompt(input: BuildImageBriefInput): string {
  const context = [
    `원고 제목: ${input.title}`,
    `키워드: ${input.keyword}`,
    input.category ? `분야: ${input.category}` : null,
    input.seoDescription ? `요약: ${input.seoDescription}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "너는 블로그 원고에 어울리는 대표 이미지를 기획하는 아트 디렉터다.",
    "아래 원고에 쓸 이미지 1장을 기획하라. 이미지는 네가 만들지 않는다 - 담당자가 이 기획을",
    "그대로 ChatGPT에 붙여넣어 이미지를 생성하거나, 명시된 범위 안에서 이미지를 찾을 것이다.",
    "",
    context,
    "",
    "작성 규칙:",
    "- SCENE(한국어): 어떤 장면·구도·분위기인지 1~2문장. 원고 주제와 직접 관련 있어야 한다",
    "- PROMPT(영어): 이미지 생성 모델에 그대로 붙여넣을 프롬프트 한 줄. 스타일(예: minimal",
    "  illustration, flat design)과 색감을 포함하고, 사진처럼 보이게 하지 않는다",
    "- ALT_TEXT(한국어): 접근성 및 SEO용 대체 텍스트 한 줄",
    "- PROHIBITED(한국어): 이 이미지에 들어가면 안 되는 것을 쉼표로 나열한다. 실존 인물, 특정",
    "  브랜드 로고·제품 실사, 저작권이 있는 캐릭터는 항상 포함한다",
    "- 실존 인물의 얼굴이나 특정 기업 로고를 프롬프트에 절대 넣지 않는다(초상권·상표권 문제)",
    "- 자극적이거나 선정적인 이미지를 요청하지 않는다",
    "",
    "출력 형식(마커를 그대로 쓰고 그 외 설명을 붙이지 마라):",
    "",
    IMAGE_BRIEF_MARKERS.scene,
    "(장면 설명)",
    "",
    IMAGE_BRIEF_MARKERS.prompt,
    "(영어 생성 프롬프트 한 줄)",
    "",
    IMAGE_BRIEF_MARKERS.altText,
    "(대체 텍스트 한 줄)",
    "",
    IMAGE_BRIEF_MARKERS.prohibited,
    "(금지 항목, 쉼표로 나열)",
  ].join("\n");
}

/** 마커 사이 텍스트를 뽑는다. 다음 마커가 없으면(마지막 필드) 끝까지 읽는다. */
function extractField(output: string, marker: string, nextMarker: string | null): string {
  const start = output.indexOf(marker);
  if (start === -1) return "";
  const contentStart = start + marker.length;
  const end = nextMarker ? output.indexOf(nextMarker, contentStart) : -1;
  const slice = end === -1 ? output.slice(contentStart) : output.slice(contentStart, end);
  return slice.trim();
}

function parseImageBrief(output: string): ParsedImageBrief | null {
  const scene = extractField(output, IMAGE_BRIEF_MARKERS.scene, IMAGE_BRIEF_MARKERS.prompt);
  const prompt = extractField(output, IMAGE_BRIEF_MARKERS.prompt, IMAGE_BRIEF_MARKERS.altText);
  const altText = extractField(output, IMAGE_BRIEF_MARKERS.altText, IMAGE_BRIEF_MARKERS.prohibited);
  const prohibited = extractField(output, IMAGE_BRIEF_MARKERS.prohibited, null);

  // scene/prompt가 없으면 브리프로서 쓸모가 없다 - 파싱 실패로 취급한다. alt_text/prohibited는
  // 비어 있어도 브리프 자체는 살릴 수 있다(사람이 직접 채울 수 있는 항목이다).
  if (!scene || !prompt) return null;

  return { scene, prompt, altText, prohibited };
}

/**
 * 이미지 브리프를 만든다. 실패해도 예외를 던지지 않는다 - 브리프 생성은 승인 흐름의 부가 단계이지
 * 필수 단계가 아니다(실패해도 승인 자체는 이미 끝나 있어야 한다).
 */
export async function buildImageBrief(
  input: BuildImageBriefInput,
  options: ImageBriefOptions = {}
): Promise<BuildImageBriefResult> {
  const startedAt = Date.now();

  const generate =
    options.generateBrief ?? ((prompt: string) => runHeadlessClaude({ prompt, timeoutMs: IMAGE_BRIEF_TIMEOUT_MS }));

  const result = await generate(buildPrompt(input));
  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    return { ok: false, error: result.error, durationMs };
  }

  const brief = parseImageBrief(result.output);
  if (!brief) {
    return { ok: false, error: "이미지 브리프 출력에서 SCENE/PROMPT를 찾지 못했습니다.", durationMs };
  }

  return { ok: true, brief, durationMs };
}
