// 슬라이드 스크린샷에서 **글자를 읽는다**(헤드리스 claude -p + Read 도구).
//
// 왜 모델인가: "이 글자가 뭐라고 적혀 있나"는 규칙으로 못 쓴다. 반대로 브라우저 조작은 모델에
// 맡기지 않는다 - 분업 근거는 INSTAGRAM_CAPTURE_AUTOMATION.md.
//
// 2026-09-23 재설계로 판정이 줄었다. 예전에는 "이 사진을 원고에 그대로 쓸 수 있나"(hasOverlay)와
// "대체 사진을 찾을 검색어"(description)까지 물었지만, 이제 게시물 이미지는 쓰지 않는다. 남은
// 일은 **글자를 옮겨 적고 주제를 파악하는 것**뿐이다.
//
// 얼굴로 인물을 특정하지 말라는 규칙(2026-09-21 실측 오판)은 그대로 싣는다 - 주제어에 엉뚱한
// 인물명이 박히면 조사 전체가 틀어진다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";
import { VALID_CATEGORIES } from "./parseCaptureFile.js";
import type { CarouselCapture, CarouselJudgement, SlideJudgement } from "./captureTypes.js";
import type { InstagramQueueEntry } from "./types.js";

export function buildJudgePrompt(capture: CarouselCapture, entry: InstagramQueueEntry): string {
  return [
    "인스타그램 게시물의 슬라이드를 한 장씩 내려받았다. **Read 도구로 전부 열어 보고** 아래를",
    "뽑아낸다. 이 게시물의 사진은 원고에 쓰지 않는다 - 필요한 것은 **글자와 주제**뿐이다.",
    "",
    `게시물 URL: ${entry.instagramUrl}`,
    capture.caption ? `게시물 캡션:\n"""${capture.caption}"""` : "게시물 캡션: (없음)",
    "",
    "## 슬라이드",
    ...capture.slides.map((s) => `${s.slideIndex}. ${s.localPath}`),
    "",
    "## 뽑아낼 것",
    "1. **burnedInText** - 이미지에 박힌 글자를 **그대로** 옮겨 적는다. 없으면 빈 문자열.",
    "   요약하거나 다듬지 않는다. 오타도 그대로 둔다 - 이게 자료조사의 1차 근거다.",
    "   계정명·로고·워터마크처럼 내용과 무관한 글자는 적지 않는다.",
    "2. **searchKeyword** - 게시물 전체의 주제어. 자료조사와 원고 제목의 씨앗이라 짧고 구체적으로.",
    "   캡션과 번인 텍스트를 함께 보고 정한다.",
    "   **얼굴로 인물을 특정하지 않는다** - 한국 배우·선수 얼굴은 신뢰성 있게 구분되지 않는다",
    "   (실측 오판 있음). 캡션이나 글자가 말하는 인물을 쓰고, 어디에도 없으면 인물명을 적지 않는다.",
    `3. **category** - ${VALID_CATEGORIES.join(" / ")} 중 하나. 애매하면 null.`,
    "",
    "슬라이드는 **빠짐없이** 읽는다 - 뒤쪽 슬라이드에만 있는 정보가 많다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const SCHEMA = {
  type: "object",
  required: ["searchKeyword", "category", "slides"],
  properties: {
    searchKeyword: { type: "string" },
    category: { type: ["string", "null"] },
    slides: {
      type: "array",
      items: {
        type: "object",
        required: ["slideIndex", "burnedInText"],
        properties: {
          slideIndex: { type: "integer" },
          burnedInText: { type: "string" },
        },
      },
    },
  },
};

/** 모델 출력을 CarouselJudgement로 정규화한다. 모양이 틀린 슬라이드는 버린다(글자를 못 얻을 뿐이다). */
export function normalizeJudgement(raw: unknown): CarouselJudgement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const searchKeyword = typeof obj.searchKeyword === "string" ? obj.searchKeyword : "";
  const category =
    typeof obj.category === "string" && VALID_CATEGORIES.includes(obj.category as never) ? obj.category : null;

  const slides: SlideJudgement[] = Array.isArray(obj.slides)
    ? obj.slides.flatMap((s): SlideJudgement[] => {
        if (!s || typeof s !== "object") return [];
        const row = s as Record<string, unknown>;
        if (typeof row.slideIndex !== "number" || !Number.isInteger(row.slideIndex)) return [];
        return [
          {
            slideIndex: row.slideIndex,
            burnedInText: typeof row.burnedInText === "string" ? row.burnedInText : "",
          },
        ];
      })
    : [];

  return { searchKeyword, category, slides };
}

export async function judgeCarouselSlides(
  capture: CarouselCapture,
  entry: InstagramQueueEntry
): Promise<CarouselJudgement> {
  const prompt = [
    buildJudgePrompt(capture, entry),
    "",
    "## 출력 형식(엄격)",
    "마지막 줄에 **JSON 한 줄만** 출력한다. 코드펜스로 감싸지 않는다. 아래 JSON Schema를 정확히 따른다:",
    JSON.stringify(SCHEMA),
  ].join("\n");

  const result = await runHeadlessClaude({
    prompt,
    // Read만 열어 준다 - 슬라이드 파일을 보는 것 외에 필요한 권한이 없다.
    allowedTools: ["Read"],
    permissionMode: "acceptEdits",
    timeoutMs: 600_000,
    cwd: capture.tempDir,
  });

  if (!result.ok) throw new Error(`슬라이드 판정 실패: ${result.error}`);

  const normalized = normalizeJudgement(extractTrailingJson(result.output));
  if (!normalized) throw new Error(`슬라이드 판정 출력에서 JSON을 찾지 못했습니다: ${result.output.trim().slice(-300)}`);
  return normalized;
}
