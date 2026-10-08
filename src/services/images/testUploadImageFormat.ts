// 업로드되는 이미지의 이름·content-type·바이트가 일치하는지 검증한다(2026-10-08). 실행: npm run test:upload-image-format
//
// 계기: 웹 수집 이미지의 AVIF가 Storage에 `2-web.png`로 올라갔다(content-type만 image/avif). 티스토리 에디터가 그
// 파일에서 꼬여 뒤의 정상 이미지 4장까지 연쇄로 실패했다. 발행기마다 방어하지 않도록 **수집·업로드 쪽에서** 막는다.
//
// 실제 Chromium으로 변환까지 돌린다. 브라우저 버전이 다른 환경(클라우드 세션)은 PLAYWRIGHT_CHROMIUM_PATH.
// Supabase는 필요 없다 - 업로드 직전 준비(prepareUploadImage)만 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { shouldOptimize } from "./optimizeImage.js";
import { MIME_BY_FORMAT, sniffImageFormat } from "./sniffImageFormat.js";
import { extensionFor, prepareUploadImage } from "../supabase/storage/uploadArticleImage.js";

// 실제 AVIF(63KB, 150KB 미만이라 옛 스킵 규칙에 걸리던 크기). AOM 공식 테스트 파일(Link-U fox).
const AVIF = readFileSync(fileURLToPath(new URL("./fixtures/small.avif", import.meta.url)));

async function main(): Promise<void> {
  // 1) 형식 판별과 확장자 - AVIF가 더 이상 png로 떨어지지 않는다.
  assert.equal(sniffImageFormat(AVIF), "avif", "픽스처는 실제 AVIF");
  assert.equal(extensionFor("image/avif"), "avif", "avif → .avif (옛 동작: png)");
  assert.equal(extensionFor("image/jpeg"), "jpg");
  assert.equal(extensionFor("image/webp"), "webp");
  assert.equal(extensionFor("image/gif"), "gif");
  assert.equal(extensionFor("application/octet-stream"), "png", "모르는 형식은 예전처럼 png");
  assert.equal(MIME_BY_FORMAT.avif, "image/avif");
  console.log("✅ 형식 판별·확장자 - avif는 .avif");

  // 2) 변환 대상 규칙 - AVIF는 작아도, 줄지 않아도 변환한다(형식 정규화).
  assert.equal(shouldOptimize("image/avif", 14_900), null, "14.9KB짜리 AVIF도 대상(실측 사례 크기)");
  assert.notEqual(shouldOptimize("image/png", 14_900), null, "PNG는 작으면 여전히 건드리지 않는다");
  console.log("✅ 변환 대상 - AVIF는 크기와 무관, PNG는 그대로");

  // 3) A: 거짓 content-type(png)으로 온 작은 AVIF → WebP로 정규화. optimize를 끈 호출(캡처·표 경로)도 마찬가지다.
  {
    const out = await prepareUploadImage({ imageBuffer: AVIF, mimeType: "image/png", optimize: false, label: "test" });
    assert.equal(sniffImageFormat(out.buffer), "webp", "바이트가 WebP로 바뀌어야 한다");
    assert.equal(out.mimeType, "image/webp", "content-type이 바이트와 일치");
    assert.equal(out.extension, "webp", "이름이 바이트와 일치");
    console.log("✅ A - 거짓 png로 온 작은 AVIF → WebP, 이름·content-type·바이트 일치");
  }

  // 4) 인포그래픽처럼 화질을 지정한 호출도 같다.
  {
    const out = await prepareUploadImage({ imageBuffer: AVIF, mimeType: "image/avif", optimize: { quality: 0.9 }, label: "test" });
    assert.equal(sniffImageFormat(out.buffer), "webp");
    assert.equal(out.extension, "webp");
    console.log("✅ A - optimize 옵션을 줘도 AVIF는 WebP");
  }

  // 5) B: 변환이 실패해도(브라우저 없음) AVIF는 **정직한 이름**으로 올라간다. 거짓 .png가 되면 안 된다.
  {
    const saved = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    process.env.PLAYWRIGHT_CHROMIUM_PATH = "/nonexistent/chromium";
    try {
      const warn = console.warn;
      console.warn = () => {};
      const out = await prepareUploadImage({ imageBuffer: AVIF, mimeType: "image/png", optimize: false, label: "test" });
      console.warn = warn;
      assert.equal(sniffImageFormat(out.buffer), "avif", "변환 실패 시 원본 유지");
      assert.equal(out.mimeType, "image/avif", "거짓 png 표기를 바로잡는다");
      assert.equal(out.extension, "avif", "이름도 .avif - 이름과 내용물이 어긋나면 안 된다");
    } finally {
      if (saved === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_PATH;
      else process.env.PLAYWRIGHT_CHROMIUM_PATH = saved;
    }
    console.log("✅ B - 변환 실패 시 안전망: 거짓 .png가 아니라 .avif");
  }

  // 6) AVIF가 아닌 이미지는 건드리지 않는다(회귀). JPEG 헤더 + 거짓 png 표기 → 이름만 jpg로 바로잡힌다.
  {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(64)]);
    const out = await prepareUploadImage({ imageBuffer: jpeg, mimeType: "image/png", optimize: false, label: "test" });
    assert.equal(out.buffer, jpeg, "JPEG는 바이트를 바꾸지 않는다");
    assert.equal(out.mimeType, "image/jpeg");
    assert.equal(out.extension, "jpg");

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const same = await prepareUploadImage({ imageBuffer: png, mimeType: "image/png", optimize: false, label: "test" });
    assert.equal(same.buffer, png);
    assert.equal(same.extension, "png");
    console.log("✅ 회귀 - JPEG·PNG는 바이트 불변, 거짓 표기만 바로잡음");
  }

  console.log("\n🎉 업로드 이미지 형식 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
