// 이미지 바이트에서 **치수만** 읽는다(2026-11-08). 디코딩하지 않고 헤더만 본다 - 브라우저를 띄우지 않으므로
// 모든 업로드 경로에서 공짜로 부를 수 있다.
//
// 왜 필요한가(2026-11-08 실측): `optimizeImage`의 건너뛰기 규칙이 전부 **용량** 기준이라
// (`MIN_BYTES_TO_OPTIMIZE` 150KB 미만 / `MAX_RESULT_RATIO` 충분히 줄 때만) 치수 상한(`MAX_SIDE_PX`)이
// 용량에 가려진다. 작은 파일이 큰 치수일 수 있는데, 치수를 줄이는 일은 용량이 얼마든 해야 한다.
// 치수를 미리 알면 "큰 치수"를 용량과 무관하게 변환 대상으로 올릴 수 있다.
//
// 발행 HTML의 `<img width height>`도 이 값을 쓴다 - 치수를 모르는 이미지에는 속성을 넣지 않는다
// (틀린 치수는 없는 것보다 나쁘다). 그래서 이 함수는 **확신이 없으면 null**을 돌려준다.

export type ImageSize = { width: number; height: number };

/** JPEG: SOF 마커(0xC0~0xCF 중 DHT·JPG·DAC 제외)의 높이·너비. */
function jpegSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // 바이트 스터핑·잡음은 건너뛴다.
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // 스캔 시작 전에 SOF가 없었다.
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 >= buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** PNG: IHDR의 너비·높이(시그니처 8 + 길이 4 + 타입 4 = 16). */
function pngSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 24) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** GIF: 논리 화면 크기(리틀엔디언). */
function gifSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

/** WebP: VP8(lossy) / VP8L(lossless) / VP8X(확장) 세 가지 헤더. */
function webpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // 프레임 태그 3바이트 + 싱크 코드 0x9d 0x01 0x2a 뒤에 14비트 너비·높이.
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // 캔버스 크기는 24비트 리틀엔디언 (값 - 1).
    const width = buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
    const height = buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);
    return { width: width + 1, height: height + 1 };
  }
  return null;
}

/**
 * AVIF(ISOBMFF): `ispe` 박스의 너비·높이. 박스 트리를 완전히 파싱하지 않고 첫 `ispe`를 찾는다 -
 * 썸네일이 먼저 오는 파일은 드물고, 틀리면 아래 호출부가 치수를 쓰지 않을 뿐이다(그래서 범위를 앞쪽으로 제한한다).
 */
function avifSize(buffer: Buffer): ImageSize | null {
  const limit = Math.min(buffer.length - 12, 64 * 1024);
  for (let offset = 0; offset < limit; offset += 1) {
    if (buffer[offset] === 0x69 && buffer[offset + 1] === 0x73 && buffer[offset + 2] === 0x70 && buffer[offset + 3] === 0x65) {
      // ispe: 버전·플래그 4바이트 뒤에 너비·높이(빅엔디언 32비트).
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return null;
}

/**
 * 바이트에서 치수를 읽는다. **형식을 못 읽거나 값이 이상하면 null**이다 - 모르면 모른다고 해야
 * 호출부가 "치수 상한 미적용"·"속성 없음"으로 안전하게 떨어진다.
 */
export function readImageSize(buffer: Buffer): ImageSize | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  let size: ImageSize | null = null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) size = jpegSize(buffer);
  else if (buffer.toString("ascii", 1, 4) === "PNG") size = pngSize(buffer);
  else if (buffer.toString("ascii", 0, 3) === "GIF") size = gifSize(buffer);
  else if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") size = webpSize(buffer);
  else if (buffer.toString("ascii", 4, 8) === "ftyp") size = avifSize(buffer);

  if (!size) return null;
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  // 터무니없는 값은 잘못 읽은 것으로 본다(현실의 이미지는 이 범위 안이다).
  if (width > 100_000 || height > 100_000) return null;
  return { width, height };
}

/** 긴 변이 상한을 넘는가. 치수를 모르면 false - 모르는 것을 근거로 변환하지 않는다. */
export function isOversize(size: ImageSize | null, maxSide: number): boolean {
  return Boolean(size && Math.max(size.width, size.height) > maxSide);
}
