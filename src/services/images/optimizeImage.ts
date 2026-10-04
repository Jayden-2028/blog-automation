// 저장소에 올리기 전에 이미지를 WebP로 바꾸고 크기를 줄인다(2026-10-04).
//
// 왜: Supabase 무료 한도는 파일 1GB인데 `article-images`가 19일 만에 635MB가 됐다(하루 약 33MB).
// 절반이 AI 생성 PNG로, 장당 평균 1.37MB다. 웹 검색 수집분에는 13MB짜리도 있었다.
// 본문에는 가로 700px 안팎으로 보이는 이미지라 이 해상도·용량은 쓸모없이 크다.
//
// 라이브러리(sharp 등)를 새로 넣지 않고 Chromium canvas로 변환한다 - cropTallImage.ts와 같은 이유다
// (표 렌더·캡처 때문에 러너와 맥에 playwright가 이미 있다).
//
// **best-effort다.** 변환이 실패하거나 결과가 더 크면 원본을 그대로 돌려준다 - 이미지 최적화가
// 원고 준비를 막으면 안 된다.
//
// 글자가 읽혀야 하는 이미지(인포그래픽·표·캡처)는 호출하는 쪽이 `quality`를 높이거나 건너뛴다.

import { chromium } from "playwright";

/** 긴 변이 이보다 크면 줄인다. 본문 표시 폭의 2배쯤 - 고해상도 화면에서도 선명하다. */
export const MAX_SIDE_PX = 1600;
/** 사진·일러스트 기본 화질. WebP 0.82는 PNG 대비 대개 85~90% 작아진다. */
export const DEFAULT_QUALITY = 0.82;
/** 이보다 작은 파일은 건드리지 않는다. 얻는 게 적고 화질만 잃는다. */
export const MIN_BYTES_TO_OPTIMIZE = 150 * 1024;
/** 결과가 원본의 이 비율 이하일 때만 바꾼다. 조금만 작아지는 변환은 화질 손실이 아깝다. */
export const MAX_RESULT_RATIO = 0.9;

const OPTIMIZABLE = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export type OptimizeImageInput = {
  buffer: Buffer;
  mimeType: string;
  /** 0~1. 기본 0.82. 글자가 든 이미지는 0.9 이상을 쓴다. */
  quality?: number;
  maxSide?: number;
};

export type OptimizeImageResult = {
  buffer: Buffer;
  mimeType: string;
  /** 실제로 바꿨는가. false면 buffer/mimeType은 입력 그대로다. */
  optimized: boolean;
  /** 바꾸지 않았다면 그 이유(로그용). */
  skippedReason?: string;
  originalBytes: number;
  width?: number;
  height?: number;
};

export function shouldOptimize(mimeType: string, bytes: number): string | null {
  const type = mimeType.toLowerCase();
  if (!OPTIMIZABLE.has(type)) return `대상 형식이 아님(${mimeType})`;
  if (bytes < MIN_BYTES_TO_OPTIMIZE) return `이미 작음(${Math.round(bytes / 1024)}KB)`;
  return null;
}

/** 긴 변을 maxSide로 맞추는 새 크기. 이미 작으면 그대로. 확대하지 않는다. */
export function targetSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= maxSide) return { width, height };
  const scale = maxSide / longSide;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function optimizeImage(input: OptimizeImageInput): Promise<OptimizeImageResult> {
  const originalBytes = input.buffer.length;
  const keep = (reason: string): OptimizeImageResult => ({
    buffer: input.buffer,
    mimeType: input.mimeType,
    optimized: false,
    skippedReason: reason,
    originalBytes,
  });

  const skip = shouldOptimize(input.mimeType, originalBytes);
  if (skip) return keep(skip);

  const maxSide = input.maxSide ?? MAX_SIDE_PX;
  const quality = Math.min(1, Math.max(0.1, input.quality ?? DEFAULT_QUALITY));

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;

    // 브라우저 안에서 도는 코드라 문자열로 넘긴다(이 파일은 DOM 타입을 쓰지 않는 Node 모듈이다).
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><script>
        (async () => {
          try {
            const image = new Image();
            image.src = ${JSON.stringify(dataUrl)};
            await image.decode();
            const longSide = Math.max(image.naturalWidth, image.naturalHeight);
            const scale = longSide > ${maxSide} ? ${maxSide} / longSide : 1;
            const width = Math.max(1, Math.round(image.naturalWidth * scale));
            const height = Math.max(1, Math.round(image.naturalHeight * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            context.imageSmoothingQuality = "high";
            context.drawImage(image, 0, 0, width, height);
            window.__optimized = { data: canvas.toDataURL("image/webp", ${quality}), width, height };
          } catch (error) {
            window.__optimized = { data: "", width: 0, height: 0 };
          }
        })();
      </script>`,
      { waitUntil: "load" }
    );
    await page.waitForFunction("window.__optimized !== undefined", null, { timeout: 60_000 });
    const out = (await page.evaluate("window.__optimized")) as { data: string; width: number; height: number };

    if (!out.data.startsWith("data:image/webp")) return keep("canvas가 WebP를 만들지 못함");
    const buffer = Buffer.from(out.data.slice(out.data.indexOf(",") + 1), "base64");
    if (buffer.length > originalBytes * MAX_RESULT_RATIO) {
      return keep(`줄어든 폭이 작음(${Math.round(originalBytes / 1024)}KB → ${Math.round(buffer.length / 1024)}KB)`);
    }
    return { buffer, mimeType: "image/webp", optimized: true, originalBytes, width: out.width, height: out.height };
  } catch (error) {
    return keep(`변환 실패: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}
