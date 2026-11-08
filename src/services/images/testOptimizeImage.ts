// optimizeImage 검증(2026-10-04). 순수 함수는 바로, 변환은 실제 Chromium canvas로 확인한다.
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { MAX_SIDE_PX, MIN_BYTES_TO_OPTIMIZE, optimizeImage, shouldOptimize, targetSize } from "./optimizeImage.js";

/** Chromium으로 단색에 가까운 큰 JPEG를 만든다 - **치수는 크고 용량은 작은** 실측 사례를 흉내 낸다. */
async function makeFlatJpeg(width: number, height: number): Promise<Buffer> {
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><canvas id=c></canvas>");
    const dataUrl = (await page.evaluate(`(() => {
      const c = document.getElementById("c"); c.width = ${width}; c.height = ${height};
      const x = c.getContext("2d");
      x.fillStyle = "#f2f2f2"; x.fillRect(0, 0, ${width}, ${height});
      x.fillStyle = "#222"; x.font = "40px sans-serif"; x.fillText("fare table", 80, 120);
      return c.toDataURL("image/jpeg", 0.7);
    })()`)) as string;
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  } finally {
    await browser.close();
  }
}

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
  // 치수 상한은 **용량과 무관하다**(2026-11-08). 작은 파일이 큰 치수일 수 있다.
  assert.equal(
    shouldOptimize("image/jpeg", 20 * 1024, { width: 2560, height: 1920 }),
    null,
    "용량이 작아도 긴 변이 상한을 넘으면 대상"
  );
  assert.notEqual(
    shouldOptimize("image/jpeg", 20 * 1024, { width: 800, height: 600 }),
    null,
    "치수도 용량도 작으면 예전처럼 건너뛴다"
  );
  assert.notEqual(shouldOptimize("image/jpeg", 20 * 1024, null), null, "치수를 모르면 예전 규칙 그대로(용량 기준)");
  assert.notEqual(shouldOptimize("image/gif", 10_000, { width: 4000, height: 4000 }), null, "대상 형식이 아니면 치수와 무관하게 제외");
  console.log("✅ 규칙(크기·형식·최소 용량·치수 상한)");

  // 큰 PNG -> WebP, 긴 변 1600 이하
  const big = await makePng(2400, 1800);
  const result = await optimizeImage({ buffer: big, mimeType: "image/png" });
  assert.equal(result.optimized, true, `변환돼야 한다(${result.skippedReason ?? ""})`);
  assert.equal(result.mimeType, "image/webp");
  assert.ok(result.buffer.length < big.length * 0.5, `절반 이하로 줄어야 한다(${big.length} → ${result.buffer.length})`);
  assert.ok(Math.max(result.width ?? 0, result.height ?? 0) <= MAX_SIDE_PX, "긴 변이 상한 이하");
  assert.equal(result.buffer.subarray(8, 12).toString("ascii"), "WEBP", "실제 WebP 바이트");
  console.log(`✅ 2400×1800 PNG ${Math.round(big.length / 1024)}KB → WebP ${Math.round(result.buffer.length / 1024)}KB (${result.width}×${result.height})`);

  // **큰 치수·작은 용량**: 2026-11-08 실측(2560×1920 페이지 캡처)이 빠져나가던 구멍이다.
  // 150KB 미만이라 옛 규칙으로는 "이미 작음"으로 건너뛰었고, 줄어든 폭이 작아도 바꿔야 한다.
  const flat = await makeFlatJpeg(2560, 1920);
  assert.ok(flat.length < MIN_BYTES_TO_OPTIMIZE, `실측과 같은 "큰 치수·작은 용량"이어야 한다(${flat.length}B)`);
  const shrunk = await optimizeImage({ buffer: flat, mimeType: "image/jpeg" });
  assert.equal(shrunk.optimized, true, `치수가 크면 용량이 작아도 줄여야 한다(${shrunk.skippedReason ?? ""})`);
  assert.equal(shrunk.oversize, true, "치수 상한을 넘었다는 사실이 결과에 남는다");
  assert.ok(Math.max(shrunk.width ?? 0, shrunk.height ?? 0) <= MAX_SIDE_PX, `긴 변이 상한 이하(${shrunk.width}×${shrunk.height})`);
  assert.deepEqual([shrunk.width, shrunk.height], [1600, 1200], "4:3 비율 유지");
  console.log(`✅ 2560×1920 ${Math.round(flat.length / 1024)}KB(상한 미만 용량) → ${shrunk.width}×${shrunk.height}`);

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
  assert.ok(broken.skippedReason, "실패 사유가 남는다");
  console.log("✅ 건너뜀·실패 시 원본 유지");

  // 줄여야 했는데 못 줄인 경우: **사유를 삼키지 않는다**(호출부가 경고로 남긴다).
  const oversizeHeaderOnly = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    (() => {
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write("IHDR", 4, "ascii");
      ihdr.writeUInt32BE(2560, 8);
      ihdr.writeUInt32BE(1920, 12);
      return ihdr;
    })(),
  ]);
  const failedResize = await optimizeImage({ buffer: oversizeHeaderOnly, mimeType: "image/png" });
  assert.equal(failedResize.optimized, false, "디코드가 안 되면 원본 유지");
  assert.equal(failedResize.oversize, true, "줄여야 했다는 사실이 남는다");
  assert.ok(failedResize.skippedReason, "못 줄인 사유가 남는다");
  assert.deepEqual([failedResize.width, failedResize.height], [2560, 1920], "원본 치수를 돌려준다");
  console.log(`✅ 못 줄였을 때 사유가 남는다: ${failedResize.skippedReason}`);

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
