// readImageSize 검증(2026-11-08). 네트워크·브라우저 없이 헤더 바이트만 본다.
//
// 이 함수가 틀리면 두 군데가 같이 틀린다: ① 치수 상한을 넘은 이미지를 못 알아봐 그냥 올라가고,
// ② 발행 HTML에 **틀린 `<img width height>`**가 붙는다. ②는 없는 것보다 나쁘므로, "모르면 null"이
// 지켜지는지를 함께 단언한다.
import assert from "node:assert/strict";

import { isOversize, readImageSize } from "./imageDimensions.js";

/** 최소 PNG 헤더: 시그니처 + IHDR(width/height 빅엔디언). 픽셀 데이터는 필요 없다. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** 최소 JPEG: SOI + APP0(건너뛰어야 한다) + SOF0(높이·너비). */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(18, 2); // 길이(자기 자신 포함)
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

/** 최소 GIF89a: 논리 화면 크기(리틀엔디언). */
function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(20);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

/** 최소 WebP(VP8 lossy): RIFF/WEBP + 'VP8 ' + 싱크 코드 + 14비트 너비·높이. */
function webpLossy(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  buffer[23] = 0x9d;
  buffer[24] = 0x01;
  buffer[25] = 0x2a;
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
}

/** 최소 WebP(VP8X 확장): 24비트 캔버스 크기(값 - 1). */
function webpExtended(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

function main(): void {
  assert.deepEqual(readImageSize(png(2560, 1920)), { width: 2560, height: 1920 }, "PNG IHDR");
  assert.deepEqual(readImageSize(jpeg(2560, 1920)), { width: 2560, height: 1920 }, "JPEG는 APP0을 건너뛰고 SOF0을 읽는다");
  assert.deepEqual(readImageSize(gif(640, 480)), { width: 640, height: 480 }, "GIF 논리 화면");
  assert.deepEqual(readImageSize(webpLossy(1600, 1200)), { width: 1600, height: 1200 }, "WebP(VP8)");
  assert.deepEqual(readImageSize(webpExtended(3000, 2000)), { width: 3000, height: 2000 }, "WebP(VP8X)");
  console.log("✅ 형식별 헤더에서 치수를 읽는다");

  // **모르면 null** - 틀린 치수를 내놓느니 모른다고 해야 호출부가 속성을 안 붙이고 상한도 안 건다.
  assert.equal(readImageSize(Buffer.from("not an image at all")), null, "이미지가 아니면 null");
  assert.equal(readImageSize(Buffer.alloc(4)), null, "너무 짧으면 null");
  assert.equal(readImageSize(Buffer.alloc(64)), null, "0으로 찬 버퍼는 null(0×0을 내놓지 않는다)");
  const brokenJpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x11)]);
  assert.equal(readImageSize(brokenJpeg), null, "SOF가 없는 JPEG는 null");
  console.log("✅ 못 읽으면 null");

  // 치수 상한 판정. **치수를 모르면 false** - 모르는 것을 근거로 변환하지 않는다.
  assert.equal(isOversize({ width: 2560, height: 1920 }, 1600), true, "2560px는 상한 초과");
  assert.equal(isOversize({ width: 900, height: 2000 }, 1600), true, "세로로 긴 것도 긴 변 기준");
  assert.equal(isOversize({ width: 1600, height: 1200 }, 1600), false, "상한과 같으면 초과가 아니다");
  assert.equal(isOversize(null, 1600), false, "치수를 모르면 초과로 보지 않는다");
  console.log("✅ 긴 변 상한 판정");

  console.log("\n✅ 전체 테스트 통과");
}

main();
