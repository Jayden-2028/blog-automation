// 캡처 JSON 검증 규격 고정. 이 검사가 느슨해지면 잘못된 JSON이 통과해 job row가 먼저 생기고,
// 그때는 되돌리기가 번거롭다(article_jobs + Storage 업로드).

import { strict as assert } from "node:assert";

import { parseCaptureFile } from "./parseCaptureFile.js";

function valid(): Record<string, unknown> {
  return {
    queueEntryId: "42",
    instagramUrl: "https://www.instagram.com/p/abc/",
    caption: "캡션 원문",
    burnedInText: ["슬라이드에 적힌 텍스트"],
    searchKeyword: "김지원 밀라노",
    category: "entertainment",
    images: [{ slideIndex: 1, kind: "instagram_capture", localPath: "/tmp/a.png" }],
  };
}

function errorsOf(patch: Record<string, unknown>): string[] {
  const r = parseCaptureFile({ ...valid(), ...patch });
  return r.ok ? [] : r.errors;
}

const tests: Array<[string, () => void]> = [
  [
    "온전한 JSON은 통과하고 정규화된다",
    () => {
      const r = parseCaptureFile(valid());
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.capture.searchKeyword, "김지원 밀라노");
      assert.equal(r.capture.images[0].sourcePage, null);
      assert.equal(r.capture.profileEmbedUrl, null);
    },
  ],
  [
    "필수 문자열이 비면 잡는다",
    () => {
      assert.ok(errorsOf({ queueEntryId: "" }).some((e) => e.includes("queueEntryId")));
      assert.ok(errorsOf({ searchKeyword: "   " }).some((e) => e.includes("searchKeyword")));
      assert.ok(errorsOf({ instagramUrl: undefined }).some((e) => e.includes("instagramUrl")));
    },
  ],
  [
    "web_alternative는 출처 페이지가 없으면 거부한다",
    () => {
      const errs = errorsOf({ images: [{ slideIndex: 1, kind: "web_alternative", localPath: "/tmp/a.png" }] });
      assert.ok(errs.some((e) => e.includes("sourcePage")));
    },
  ],
  [
    "slideIndex는 1 이상의 정수여야 한다",
    () => {
      assert.ok(errorsOf({ images: [{ slideIndex: 0, kind: "instagram_capture", localPath: "/a" }] }).length > 0);
      assert.ok(errorsOf({ images: [{ slideIndex: 1.5, kind: "instagram_capture", localPath: "/a" }] }).length > 0);
    },
  ],
  [
    "kind는 정해진 두 값만 받는다",
    () => {
      assert.ok(errorsOf({ images: [{ slideIndex: 1, kind: "screenshot", localPath: "/a" }] }).some((e) => e.includes("kind")));
    },
  ],
  [
    "카테고리는 KeywordCategory거나 null이어야 한다",
    () => {
      assert.ok(errorsOf({ category: "연예" }).some((e) => e.includes("category")));
      const r = parseCaptureFile({ ...valid(), category: null });
      assert.equal(r.ok, true);
      if (r.ok) assert.ok(r.warnings.some((w) => w.includes("category")));
    },
  ],
  [
    "같은 슬라이드의 A/B 후보는 허용, 완전 중복은 거부",
    () => {
      const ab = parseCaptureFile({
        ...valid(),
        images: [
          { slideIndex: 1, kind: "instagram_capture", localPath: "/a" },
          { slideIndex: 1, kind: "web_alternative", localPath: "/b", sourcePage: "https://news.test/1" },
        ],
      });
      assert.equal(ab.ok, true);

      const dupe = errorsOf({
        images: [
          { slideIndex: 1, kind: "instagram_capture", localPath: "/a" },
          { slideIndex: 1, kind: "instagram_capture", localPath: "/b" },
        ],
      });
      assert.ok(dupe.some((e) => e.includes("둘 이상")));
    },
  ],
  [
    "이미지 0장은 막지 않되 경고한다",
    () => {
      const r = parseCaptureFile({ ...valid(), images: [] });
      assert.equal(r.ok, true);
      if (r.ok) assert.ok(r.warnings.some((w) => w.includes("0장")));
    },
  ],
  [
    "burnedInText는 배열이어야 하고 빈 문자열은 걸러진다",
    () => {
      assert.ok(errorsOf({ burnedInText: "텍스트" }).some((e) => e.includes("burnedInText")));
      const r = parseCaptureFile({ ...valid(), burnedInText: ["a", "  ", "b"] });
      assert.equal(r.ok, true);
      if (r.ok) assert.deepEqual(r.capture.burnedInText, ["a", "b"]);
    },
  ],
  [
    "오류는 모아서 보고한다(하나 고치고 다시 돌리기 방지)",
    () => {
      const r = parseCaptureFile({ queueEntryId: "", instagramUrl: "", searchKeyword: "" });
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.errors.length >= 3, `오류가 모여야 하는데 ${r.errors.length}건`);
    },
  ],
  [
    "최상위가 객체가 아니면 거부한다",
    () => {
      assert.equal(parseCaptureFile([]).ok, false);
      assert.equal(parseCaptureFile("문자열").ok, false);
      assert.equal(parseCaptureFile(null).ok, false);
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
  console.error(`\n❌ 캡처 JSON 검증 테스트 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 캡처 JSON 검증 테스트 통과");
