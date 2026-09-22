// 슬라이드 스크린샷을 보고 판정한다(헤드리스 claude -p + Read 도구).
//
// 왜 모델인가: "워터마크가 박혀 있나 / 이 글자가 뭐라고 적혀 있나"는 규칙으로 못 쓴다.
// 반대로 브라우저 조작은 모델에 맡기지 않는다 - 분업 근거는 INSTAGRAM_CAPTURE_AUTOMATION.md.
//
// 판정 기준은 INSTAGRAM_POSTING_CONVERTER.md "이미지 소싱 정책"을 그대로 옮긴 것이다.
// 얼굴로 인물을 특정하지 말라는 규칙(2026-09-21 실측 오판)도 같이 싣는다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";
import { VALID_CATEGORIES } from "./parseCaptureFile.js";
import type { CarouselCapture, CarouselJudgement, SlideJudgement } from "./captureTypes.js";
import type { InstagramQueueEntry } from "./types.js";

export function buildJudgePrompt(capture: CarouselCapture, entry: InstagramQueueEntry): string {
  return [
    "인스타그램 게시물의 캐러셀 슬라이드를 한 장씩 내려받았다. **Read 도구로 전부 열어 보고**",
    "아래 판정을 내린다. 이 판정은 블로그 원고에 그 사진을 그대로 쓸 수 있는지를 가른다.",
    "",
    `게시물 URL: ${entry.instagramUrl}`,
    entry.rawCaption.trim() ? `사람이 붙여넣은 캡션:\n"""${entry.rawCaption.trim()}"""` : null,
    capture.caption ? `게시물에서 읽은 캡션:\n"""${capture.caption}"""` : null,
    "",
    "## 슬라이드",
    ...capture.slides.map((s) => `${s.slideIndex}. ${s.localPath}`),
    "",
    "## 판정 기준",
    "1. **hasOverlay** - 워터마크, 계정 로고, 이미지 위에 얹은 글자(번인 텍스트)가 있나?",
    "   - 사진 위에 아무것도 없는 **플랫한 단컷**이면 false.",
    "   - 조금이라도 있으면 true. 애매하면 true로 한다 - 잘못 가져다 쓰는 것보다 낫다.",
    "2. **burnedInText** - 이미지에 박힌 글자를 **그대로** 옮겨 적는다. 없으면 빈 문자열.",
    "   이미지를 못 쓰더라도 이 글자는 자료조사의 1차 근거가 되므로 빠뜨리지 않는다.",
    "3. **description** - 그 슬라이드가 무엇을 보여주는지 한 줄. 대체 사진을 찾는 검색어의 재료다.",
    "   **얼굴로 인물을 특정하지 않는다** - 한국 배우·선수 얼굴은 신뢰성 있게 구분되지 않는다",
    "   (실측 오판 있음). 캡션이 말하는 인물을 쓰고, 캡션에 없으면 인물명을 적지 않는다.",
    "4. **searchKeyword** - 게시물 전체의 주제어. 자료조사와 원고 제목의 씨앗이라 짧고 구체적으로.",
    `5. **category** - ${VALID_CATEGORIES.join(" / ")} 중 하나. 애매하면 null.`,
    "",
    "슬라이드는 **빠짐없이** 판정한다 - 빠진 슬라이드는 안전하게 오버레이 있음으로 처리돼 버려진다.",
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
        required: ["slideIndex", "hasOverlay", "burnedInText", "description"],
        properties: {
          slideIndex: { type: "integer" },
          hasOverlay: { type: "boolean" },
          burnedInText: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

/** 모델 출력을 CarouselJudgement로 정규화한다. 모양이 틀린 슬라이드는 버린다(= 오버레이 있음 처리). */
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
            // 불린이 아니면 안전한 쪽으로 - 그대로 쓰지 않는다.
            hasOverlay: typeof row.hasOverlay === "boolean" ? row.hasOverlay : true,
            burnedInText: typeof row.burnedInText === "string" ? row.burnedInText : "",
            description: typeof row.description === "string" ? row.description : "",
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
