// optimizeImage 검증(2026-10-04). 순수 함수는 바로, 변환은 실제 Chromium canvas로 확인한다.
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { MAX_SIDE_PX, optimizeImage, shouldOptimize, targetSize } from "./optimizeImage.js";

/** Chromium으로 노이즈가 섞인 큰 PNG를 만든다(압축이 잘 안 되는 실제 일러스트와 비슷하게). */
async function makePng(width: number, height: number): Promise<Buffer> {
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><canvas id=c></canvas>");
    const dataUrl = (await page.evaluate(`(() => {
      const c = document.getElementById("c"); c.width = ${width}; c.height = ${height};
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, ${width}, ${height}); g.addColorStop(0, "#e44"); g.addColorStop(1, "#35c");
      x.fillStyle = g; x.fillRect(0, 0, ${width}, ${height});
      for (let i = 0; i < 6000; i++) { x.fillStyle = "hsl(" + (i * 37 % 360) + ",70%,55%)"; x.fillRect((i * 97) % ${width}, (i * 53) % ${height}, 24, 24); }
      return c.toDataURL("image/png");
    })()`)) as string;
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  // 순수 규칙
  assert.deepEqual(targetSize(1024, 1024, 1600), { width: 1024, height: 1024 }, "작으면 그대로(확대 금지)");
  assert.deepEqual(targetSize(3200, 1600, 1600), { width: 1600, height: 800 }, "긴 변 기준 축소");
  assert.deepEqual(targetSize(1000, 4000, 1600), { width: 400, height: 1600 }, "세로로 긴 이미지도 긴 변 기준");
  assert.equal(shouldOptimize("image/gif", 5_000_000) !== null, true, "gif는 건드리지 않는다");
  assert.equal(shouldOptimize("image/png", 50 * 1024) !== null, true, "작은 파일은 건드리지 않는다");
  assert.equal(shouldOptimize("image/png", 800 * 1024), null, "큰 PNG는 대상");
  assert.equal(shouldOptimize("image/avif", 14_900), null, "AVIF는 작아도 대상(형식 정규화, 2026-10-08)");
  console.log("✅ 규칙(크기·형식·최소 용량)");

  // 큰 PNG -> WebP, 긴 변 1600 이하
  const big = await makePng(2400, 1800);
  const result = await optimizeImage({ buffer: big, mimeType: "image/png" });
  assert.equal(result.optimized, true, `변환돼야 한다(${result.skippedReason ?? ""})`);
  assert.equal(result.mimeType, "image/webp");
  assert.ok(result.buffer.length < big.length * 0.5, `절반 이하로 줄어야 한다(${big.length} → ${result.buffer.length})`);
  assert.ok(Math.max(result.width ?? 0, result.height ?? 0) <= MAX_SIDE_PX, "긴 변이 상한 이하");
  assert.equal(result.buffer.subarray(8, 12).toString("ascii"), "WEBP", "실제 WebP 바이트");
  console.log(`✅ 2400×1800 PNG ${Math.round(big.length / 1024)}KB → WebP ${Math.round(result.buffer.length / 1024)}KB (${result.width}×${result.height})`);

  // 건너뛰는 경우는 원본 그대로
  const small = Buffer.from("tiny");
  const kept = await optimizeImage({ buffer: small, mimeType: "image/png" });
  assert.equal(kept.optimized, false);
  assert.equal(kept.buffer, small, "건너뛰면 같은 버퍼를 돌려준다");

  // 깨진 데이터는 원본 유지(원고 준비를 막지 않는다)
  const garbage = Buffer.alloc(300 * 1024, 1);
  const broken = await optimizeImage({ buffer: garbage, mimeType: "image/png" });
  assert.equal(broken.optimized, false, "디코드 실패는 원본 유지");
  assert.equal(broken.buffer, garbage);
  console.log("✅ 건너뜀·실패 시 원본 유지");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
