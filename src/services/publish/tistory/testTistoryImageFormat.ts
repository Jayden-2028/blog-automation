// sniffImageFormat 단위 테스트(2026-10-08). 계기: 웹 수집 이미지가 AVIF를 `.png` 이름으로 저장했고,
// 티스토리 에디터가 AVIF를 받으면 업로드 위젯이 꼬여 뒤의 정상 이미지까지 연쇄 유실됐다(우크라 글).
import { strict as assert } from "node:assert";

import { sniffImageFormat } from "./TistoryPublisher.js";

function bmff(brand: string): Buffer {
  // [크기 4][ "ftyp" ][브랜드 4] + 패딩
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp" + brand + "\0\0\0\0", "latin1")]);
}

const cases: [string, Buffer, string | null][] = [
  ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), "jpg"],
  ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), "png"],
  ["GIF", Buffer.from("GIF89a\0\0\0\0\0\0", "latin1"), "gif"],
  ["WEBP", Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), "webp"],
  ["AVIF(avif 브랜드)", bmff("avif"), "avif"],
  ["AVIF(avis 시퀀스)", bmff("avis"), "avif"],
  ["MP4(isom)는 AVIF가 아니다", bmff("isom"), null],
  ["빈 버퍼", Buffer.alloc(0), null],
  ["12바이트 미만", Buffer.from([0xff, 0xd8, 0xff]), null],
  ["알 수 없는 형식", Buffer.from("hello world!", "latin1"), null],
];

for (const [name, buffer, want] of cases) {
  assert.equal(sniffImageFormat(buffer), want, `${name}: ${String(want)} 이어야 합니다`);
}

console.log("✅ testTistoryImageFormat 전체 통과");
