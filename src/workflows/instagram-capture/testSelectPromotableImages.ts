// 인스타 캡처 후보 승격 규칙 불변식. 규칙이 두 군데에 복붙돼 어긋났던 사고(2026-09-22)를
// 되풀이하지 않도록, 유일한 기준인 selectPromotableImages를 여기서 고정한다.

import { strict as assert } from "node:assert";

import { readInstagramCandidates, selectPromotableImages } from "./selectPromotableImages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

function img(index: number, provider = "인스타 원본 캡처"): ManuscriptImage {
  return {
    index,
    description: `슬라이드 ${index}`,
    prompt: null,
    url: `https://example.test/${provider}/${index}.png`,
    provider,
    fileName: `${index}.png`,
    sourcePage: "https://instagram.test/p/abc",
    license: null,
  } as ManuscriptImage;
}

const tests: Array<[string, () => void]> = [
  [
    "마커 범위 안의 후보만 남는다",
    () => {
      const r = selectPromotableImages([img(1), img(2), img(3)], 2);
      assert.deepEqual(r.promote?.map((i) => i.index), [1, 2]);
      assert.equal(r.dropped, 1);
    },
  ],
  [
    "후보가 전부 마커 범위 밖이면 승격하지 않는다(promote=null)",
    () => {
      // 핵심 회귀. 빈 배열을 돌려주면 호출부가 images: [] + imagesReadyAt을 기록하고,
      // 그러면 웹 이미지 자동 검색이 전 자리를 엉뚱한 사진으로 채운다.
      const r = selectPromotableImages([img(3), img(4), img(5)], 2);
      assert.equal(r.promote, null);
      assert.equal(r.dropped, 3);
      assert.equal(r.filledSlots, 0);
    },
  ],
  [
    "같은 슬라이드의 A/B 후보는 둘 다 남지만 자리는 하나로 센다",
    () => {
      const r = selectPromotableImages([img(1, "인스타 원본 캡처"), img(1, "웹 대체 이미지"), img(2)], 3);
      assert.equal(r.promote?.length, 3);
      assert.equal(r.filledSlots, 2);
    },
  ],
  [
    "마커보다 후보 자리가 적으면 filledSlots가 그 사실을 드러낸다",
    () => {
      const r = selectPromotableImages([img(1), img(2)], 5);
      assert.equal(r.filledSlots, 2);
      assert.equal(r.dropped, 0);
    },
  ],
  [
    "후보가 없거나 빈 배열이면 승격하지 않는다",
    () => {
      assert.equal(selectPromotableImages(undefined, 3).promote, null);
      assert.equal(selectPromotableImages([], 3).promote, null);
    },
  ],
  [
    "마커가 0개면 아무것도 승격하지 않는다",
    () => {
      const r = selectPromotableImages([img(1), img(2)], 0);
      assert.equal(r.promote, null);
      assert.equal(r.dropped, 2);
    },
  ],
  [
    "인스타 job이 아니면 후보를 읽지 않는다",
    () => {
      assert.equal(readInstagramCandidates({ instagramImages: [img(1)] }), undefined);
      assert.equal(readInstagramCandidates({ source: "keyword", instagramImages: [img(1)] }), undefined);
      assert.equal(readInstagramCandidates(null), undefined);
    },
  ],
  [
    "인스타 job이면 후보를 읽는다 - instagramImages가 배열이 아니면 undefined",
    () => {
      assert.equal(readInstagramCandidates({ source: "instagram_manual", instagramImages: [img(1)] })?.length, 1);
      assert.equal(readInstagramCandidates({ source: "instagram_manual" }), undefined);
      assert.equal(readInstagramCandidates({ source: "instagram_manual", instagramImages: "nope" }), undefined);
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error instanceof Error ? error.message : error}`);
  }
}

if (failed > 0) {
  console.error(`\n❌ 인스타 승격 규칙 테스트 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 인스타 승격 규칙 테스트 통과");
