// Blogspot 원고 -> 네이버 블로그용 배리에이션 1건(2026-09-18 사용자 요청).
//
// generateArticleVariant(기준 원고 -> Blogspot)와 다른 점이 셋이다:
//
// 1. **소스가 Blogspot 원고다.** 피해야 할 중복 상대가 바로 그 글이라, 그것을 보고 달라지는 게 직접적이다.
// 2. **가볍게 바꾼다.** Blogspot 배리에이션은 "다시 쓰기가 아니라 다시 기획하기"로 소제목 구조까지
//    바꾸지만, 여기서 요구되는 건 "검색엔진이 같은 게시물로 보지 않을 수준까지만"이다(사용자 결정).
//    구조를 또 흔들면 두 글이 따로 관리해야 할 만큼 달라져 유지비만 늘어난다.
// 3. **이미지 마커를 건드리지 않는다.** 두 글이 같은 이미지를 쓰기로 했으므로(사용자 결정)
//    `[IMAGE: 설명]`의 **개수·순서·설명이 한 글자도 달라지면 안 된다** - 뷰어와 발행 코드가 마커
//    등장 순서(1부터)로 이미지를 짝짓기 때문에, 하나라도 어긋나면 엉뚱한 문단에 이미지가 붙는다.
//
// 텔레그램 흐름은 그대로다 - 이 결과물은 원고 뷰어에서만 보고 복사한다(사용자 결정).

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";

/** Blogspot 배리에이션보다 가볍게 바꾸므로 더 짧게 잡는다. */
export const NAVER_VARIANT_TIMEOUT_MS = 12 * 60 * 1000;

export const NAVER_VARIANT_MARKERS = {
  title: "### TITLE",
  tags: "### TAGS",
  body: "### BODY",
} as const;

export type NaverVariant = {
  title: string;
  tags: string[];
  /** 마크다운 본문. [IMAGE: ] 마커가 Blogspot 원고와 같은 자리·같은 개수로 남아 있다. */
  body: string;
};

export type GenerateNaverVariantResult =
  | { status: "success"; variant: NaverVariant; durationMs: number }
  | { status: "failed"; error: string };

export type GenerateNaverVariantInput = {
  category: string | null;
  /** Blogspot 배리에이션의 제목·본문. 이것과 달라지는 것이 목적이다. */
  blogspotTitle: string;
  blogspotBody: string;
  generate?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

export function buildNaverVariantPrompt(input: GenerateNaverVariantInput): string {
  const M = NAVER_VARIANT_MARKERS;
  return [
    "아래 '원본 원고'를 네이버 블로그에 올릴 판으로 다시 쓴다.",
    "같은 사람이 운영하는 다른 채널에 올릴 글이라, **검색엔진이 두 글을 같은 게시물로 보지 않을**",
    "수준까지만 바꾼다. 완전히 새로 기획하는 게 아니다.",
    "",
    "## 절대 규칙 - 이미지 마커는 한 글자도 건드리지 않는다",
    "`[IMAGE: 설명]` 줄은 **개수·순서·설명 문구를 원본 그대로** 둔다. 두 글이 같은 이미지를 쓰는데,",
    "마커 순서로 이미지를 짝지으므로 하나라도 바뀌면 엉뚱한 문단에 이미지가 붙는다.",
    "마커를 새로 만들지도, 지우지도, 위치를 옮기지도 않는다.",
    "",
    "## 절대 규칙 - 사실 보존",
    "수치·날짜·금액·고유명사·인용·제도명·링크는 원본 그대로 쓴다. 새 사실을 추가하지 않는다(웹 검색 없음).",
    "'참고 자료' 목록도 그대로 옮긴다.",
    "",
    "## 무엇을 바꾸는가",
    "- **제목**: 다른 표현으로 새로 짓는다. 핵심 키워드는 앞쪽에 그대로 두되 후킹 방식을 바꾼다.",
    "- **문장 표현**: 같은 뜻을 다른 문장으로 쓴다. 어순·연결어·서술 방식을 바꾼다.",
    "- **도입과 마무리**: 진입점과 맺음말을 다시 쓴다. 여기가 중복 판정에 특히 민감하다.",
    "- (스스로 확인만 할 것) 원본과 **연속 3어절 이상 똑같이 겹치는 문장이 없게** 한다",
    "  (숫자·날짜·제도명·고유명사·URL은 예외 - 그건 바꾸면 안 된다).",
    "",
    "## 무엇을 그대로 두는가",
    "- **소제목의 순서와 다루는 내용**. 구조를 흔들지 않는다 - 두 글이 관리해야 할 만큼 달라지면 안 된다.",
    "- 소제목 문구 자체는 다르게 써도 되지만, 그 섹션이 다루는 주제는 같아야 한다.",
    "- 문단 개수와 전체 분량도 비슷하게 유지한다.",
    "",
    "## 형식",
    "- 소제목은 `**소제목**` 볼드 한 줄(`#` 금지). 소제목 다음 줄에 빈 줄 없이 문단이 붙는다.",
    "- 어투·어미는 `prompts/writing/style/voice.md`를 Read해 그대로 따른다(카테고리와 무관하게 한 목소리).",
    input.category === "incident"
      ? "- 이 글은 사건·사고다. `prompts/writing/style/incident.md`의 습니다체·1인칭 금지를 지킨다."
      : "",
    "",
    "## 출력 형식 (아래 마커를 정확히 그대로, 순서대로)",
    M.title,
    "(새 제목 1줄)",
    M.tags,
    "(쉼표로 구분한 태그 10개 - 원본 태그를 참고하되 순서·구성을 바꿔도 된다)",
    M.body,
    "(마크다운 본문 전체. 점검 결과·작업 노트 같은 메타 텍스트를 절대 붙이지 않는다.)",
    "",
    `## 원본 원고 (제목: ${input.blogspotTitle})`,
    input.blogspotBody,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function sliceBetween(text: string, startMarker: string, endMarkers: string[]): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const from = start + startMarker.length;
  const ends = endMarkers.map((m) => text.indexOf(m, from)).filter((i) => i !== -1);
  return text.slice(from, ends.length > 0 ? Math.min(...ends) : text.length).trim();
}

/** 본문에 남은 `[IMAGE: 설명]`을 등장 순서대로 뽑는다. 원본과 대조해 마커 보존을 검증한다. */
export function imageMarkersOf(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().match(/^\[IMAGE:\s*([\s\S]*?)\]$/))
    .filter((matched): matched is RegExpMatchArray => matched !== null)
    .map((matched) => matched[1].trim());
}

export function parseNaverVariantOutput(raw: string, fallbackTitle: string): NaverVariant {
  const M = NAVER_VARIANT_MARKERS;
  const title = sliceBetween(raw, M.title, [M.tags, M.body]).split("\n")[0]?.trim() || fallbackTitle;
  const tags = sliceBetween(raw, M.tags, [M.body])
    .split("\n")[0]
    ?.split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean) ?? [];
  const body = sliceBetween(raw, M.body, []);
  return { title, tags, body };
}

export async function generateNaverVariant(
  input: GenerateNaverVariantInput
): Promise<GenerateNaverVariantResult> {
  const startedAt = Date.now();
  const generate =
    input.generate ??
    ((prompt: string) =>
      runHeadlessClaude({
        prompt,
        timeoutMs: NAVER_VARIANT_TIMEOUT_MS,
        // 파일을 읽어야 어투 규격(voice.md)을 따를 수 있다. 웹 검색은 주지 않는다(사실은 원본에서만).
        allowedTools: ["Read"],
        permissionMode: "acceptEdits",
      }));

  const result = await generate(buildNaverVariantPrompt(input));
  if (!result.ok) return { status: "failed", error: result.error };

  const variant = parseNaverVariantOutput(result.output, input.blogspotTitle);

  // 마커 형식 자체가 안 나온 대화체 응답을 성공으로 오인하지 않는다(generateArticleVariant와 같은 가드).
  if (variant.body.length < 300) {
    // 같은 job(분장놀이)에서 두 번 연속 0자였다. 원인을 보려면 모델이 실제로 뭐라고 답했는지가 필요하다.
    const head = result.output.trim().replace(/\s+/g, " ").slice(0, 240);
    return {
      status: "failed",
      error: `본문이 너무 짧습니다(${variant.body.length}자) - 마커 형식을 못 받았을 수 있습니다. 응답 앞부분: "${head}"`,
    };
  }

  // **가장 중요한 검증**: 이미지 마커가 원본과 완전히 같아야 한다. 다르면 이미지가 엉뚱한 문단에
  // 붙으므로 배리에이션을 통째로 버린다 - 잘못 붙은 이미지보다 네이버 원고가 없는 편이 낫다.
  const expected = imageMarkersOf(input.blogspotBody);
  const actual = imageMarkersOf(variant.body);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return {
      status: "failed",
      error: `이미지 마커가 원본과 다릅니다(원본 ${expected.length}개 / 결과 ${actual.length}개) - 같은 이미지를 쓸 수 없어 버립니다.`,
    };
  }

  return { status: "success", variant, durationMs: Date.now() - startedAt };
}
