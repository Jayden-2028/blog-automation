// 공유 링크 정규화. 추적 파라미터가 붙은 주소를 표준 주소로 맞추고, 게시물이 아닌 주소는 거른다.

import { strict as assert } from "node:assert";

import { canonicalPostUrl } from "./captureInstagramCarousel.js";

const cases: Array<[string, string | null]> = [
  // 큐에 실제로 들어온 형태(텔레그램 공유 링크).
  [
    "https://www.instagram.com/p/DdBDxHixLg8/?utm_source=ig_web_copy_link&stkn=NTc4MTIwNjQ2YQ==",
    "https://www.instagram.com/p/DdBDxHixLg8/",
  ],
  ["https://www.instagram.com/p/DdBDxHixLg8/", "https://www.instagram.com/p/DdBDxHixLg8/"],
  ["https://instagram.com/p/AbC-123_xyz/", "https://www.instagram.com/p/AbC-123_xyz/"],
  // 릴스·IGTV도 /p/ 로 열린다.
  ["https://www.instagram.com/reel/DdT0p-glKnj/", "https://www.instagram.com/p/DdT0p-glKnj/"],
  ["https://www.instagram.com/tv/AbCdEf/", "https://www.instagram.com/p/AbCdEf/"],
  // 게시물이 아닌 것은 거른다 - 프로필을 열면 엉뚱한 사진을 찍는다.
  ["https://www.instagram.com/tripin.ko/", null],
  ["https://example.com/p/AbCdEf/", null],
  ["그냥 텍스트", null],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = canonicalPostUrl(input)?.url ?? null;
  try {
    assert.equal(actual, expected);
    console.log(`✅ ${input.slice(0, 60)} -> ${actual ?? "(거부)"}`);
  } catch {
    failed += 1;
    console.error(`❌ ${input}\n   기대: ${expected}\n   실제: ${actual}`);
  }
}

const shortcode = canonicalPostUrl("https://www.instagram.com/p/DdBDxHixLg8/?x=1")?.shortcode;
try {
  assert.equal(shortcode, "DdBDxHixLg8");
  console.log("✅ shortcode 추출 (리다이렉트 검증에 쓴다)");
} catch {
  failed += 1;
  console.error(`❌ shortcode 추출: ${shortcode}`);
}

if (failed > 0) {
  console.error(`\n❌ 주소 정규화 테스트 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 주소 정규화 테스트 통과");
