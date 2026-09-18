// 지나치게 긴 세로 이미지를 **왜곡 없이 잘라낸다**(2026-09-18 사용자 결정).
//
// 왜(실측): 세로 이미지를 허용하자 국립중앙박물관 웹플라이어가 1080×13861(비율 1:12.8)로 저장됐다.
// 포스터가 아니라 웹페이지 한 장을 통째로 이어붙인 길이라, 본문에 넣으면 스크롤만 한참 내려간다.
// 비율을 억지로 맞춰 늘리면 글자와 얼굴이 뭉개지므로(사용자 지시) **주요 내용 부분만 잘라낸다.**
//
// 포스터·인물 프로필(1600×2400 = 1:1.5)은 건드리지 않는다 - 그건 원래 그런 형태고 그대로 쓸 수 있다.
// 1:2보다 긴 것만 대상이다.
//
// 어디를 자르는가: Claude가 이미지를 열어 "이 설명에 해당하는 내용이 세로 몇 %에 있는지"를 답하고,
// 그 지점을 중심으로 잘라낸다. 못 고르면 **위쪽**을 쓴다 - 한국 웹플라이어·공고문은 머리말과 핵심
// 비주얼을 맨 위에 두는 형식이라 위쪽이 가장 안전한 기본값이다.
//
// 자른 뒤에도 비전 검증(defaultVerifyImage)을 그대로 통과해야 저장된다. 잘못 자르면 그 자리는
// 탈락하므로, 엉뚱한 부분이 조용히 실리는 일은 없다.
//
// 이미지 라이브러리(sharp 등)를 새로 넣지 않고 Chromium canvas로 자른다 - 표 이미지 렌더 때문에
// 러너에 이미 설치돼 있어(job-publish-prepare.yml) 의존성이 늘지 않는다.

import { chromium } from "playwright";

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";

/** width/height가 이보다 작으면(= 1:2보다 길면) 자른다. 포스터·프로필(1:1.5)은 대상이 아니다. */
export const CROP_TRIGGER_RATIO = 0.5;
/** 잘라낸 결과의 목표 비율(3:4). 본문에서 한 화면에 들어오면서 세로 소재의 내용을 충분히 남긴다. */
export const CROP_TARGET_RATIO = 0.75;

export type CropTallImageInput = {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** 0(맨 위) ~ 1(맨 아래). 잘라낼 창의 중심. */
  focus: number;
};

export type CropTallImageResult =
  | { ok: true; buffer: Buffer; mimeType: string; width: number; height: number }
  | { ok: false; error: string };

/** 자를 창의 위쪽 y좌표. focus를 중심으로 하되 이미지 밖으로 나가지 않게 가둔다. */
export function cropWindowTop(height: number, cropHeight: number, focus: number): number {
  const clampedFocus = Math.min(1, Math.max(0, focus));
  const center = clampedFocus * height;
  return Math.round(Math.min(Math.max(0, center - cropHeight / 2), height - cropHeight));
}

export async function cropTallImage(input: CropTallImageInput): Promise<CropTallImageResult> {
  const cropHeight = Math.min(input.height, Math.round(input.width / CROP_TARGET_RATIO));
  const top = cropWindowTop(input.height, cropHeight, input.focus);
  // jpeg는 jpeg로 유지한다(사진은 png로 바꾸면 파일만 커진다). 그 외(webp·avif·png)는 png로 낸다.
  const outType = input.mimeType.toLowerCase().includes("jpeg") || input.mimeType.toLowerCase().includes("jpg")
    ? "image/jpeg"
    : "image/png";

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;

    // 브라우저 안에서 도는 코드라 문자열로 넘긴다(이 파일은 DOM 타입을 쓰지 않는 Node 모듈이다).
    // setContent + 스크립트 방식은 renderTableImage.ts와 같은 패턴이다.
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><script>
        (async () => {
          try {
            const image = new Image();
            image.src = ${JSON.stringify(dataUrl)};
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = ${input.width};
            canvas.height = ${cropHeight};
            const context = canvas.getContext("2d");
            // 원본의 (0, top, width, cropHeight)를 같은 크기로 그린다 - 배율 1이라 왜곡이 없다.
            context.drawImage(image, 0, ${top}, ${input.width}, ${cropHeight}, 0, 0, ${input.width}, ${cropHeight});
            window.__cropped = canvas.toDataURL(${JSON.stringify(outType)}, 0.92);
          } catch (error) {
            window.__cropped = "";
          }
        })();
      </script>`,
      { waitUntil: "load" }
    );
    await page.waitForFunction("window.__cropped !== undefined", null, { timeout: 60_000 });
    const result = (await page.evaluate("window.__cropped")) as string;

    if (!result || !result.includes(",")) return { ok: false, error: "canvas에서 이미지를 받지 못했습니다" };
    const buffer = Buffer.from(result.slice(result.indexOf(",") + 1), "base64");
    return { ok: true, buffer, mimeType: outType, width: input.width, height: cropHeight };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * 이미지를 열어 "설명에 해당하는 내용이 세로 몇 %에 있는지"를 0~1로 받는다.
 * 실패하면 0(위쪽)이다 - 판단을 못 했다고 자르기를 포기하면 13861px짜리가 그대로 실린다.
 */
export async function pickCropFocus(input: {
  filePath: string;
  alt: string;
  context: string;
}): Promise<number> {
  const prompt = [
    "아래 이미지는 세로로 아주 긴 웹 이미지다(공고문·웹플라이어 등). 본문에 넣기엔 너무 길어",
    "가로폭은 그대로 두고 세로만 잘라내려 한다. **어느 높이를 남겨야 하는지** 알려달라.",
    "",
    `파일: ${input.filePath}`,
    `이 자리에 필요한 것: ${input.alt}`,
    "이 이미지가 요약해야 할 문단:",
    `"""${input.context.slice(0, 400)}"""`,
    "",
    "Read 도구로 이미지를 열어 보고, 위 설명에 해당하는 핵심 내용(제목·주요 사진·핵심 그림)이",
    "세로 기준 어디쯤에 있는지 0부터 1 사이 숫자로 답한다. 0은 맨 위, 0.5는 한가운데, 1은 맨 아래다.",
    "판단이 서지 않으면 0을 답한다(대개 맨 위에 제목과 핵심 비주얼이 있다).",
    "",
    '마지막 줄에 JSON 한 줄만 답한다: {"focus": 0.15}',
  ].join("\n");

  const result = await runHeadlessClaude({
    prompt,
    allowedTools: ["Read"],
    permissionMode: "acceptEdits",
    timeoutMs: 120_000,
  });
  if (!result.ok) return 0;

  const parsed = extractTrailingJson(result.output) as { focus?: unknown } | null;
  const focus = typeof parsed?.focus === "number" ? parsed.focus : Number.NaN;
  return Number.isFinite(focus) ? Math.min(1, Math.max(0, focus)) : 0;
}

/**
 * 수집기가 부르는 기본 경로: 어디를 남길지 물어본 뒤 자른다. 주입 지점을 하나로 두려고 묶었다.
 */
export async function cropTallImageWithFocus(
  input: Omit<CropTallImageInput, "focus"> & { filePath: string; alt: string; context: string }
): Promise<CropTallImageResult & { focus?: number }> {
  const focus = await pickCropFocus({ filePath: input.filePath, alt: input.alt, context: input.context });
  const result = await cropTallImage({ ...input, focus });
  return { ...result, focus };
}
