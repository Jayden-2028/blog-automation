// 읽어낸 결과의 검증 규격 고정. 이 검사가 느슨해지면 잘못된 값이 통과해 job row가 먼저 생기고,
// 그때는 되돌리기가 번거롭다.

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
      assert.equal(r.capture.caption, "캡션 원문");
      assert.ok(!("images" in r.capture), "이미지 필드가 살아나면 옛 설계가 돌아온 것이다");
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
    "카테고리는 KeywordCategory거나 null이어야 한다",
    () => {
      assert.ok(errorsOf({ category: "연예" }).some((e) => e.includes("category")));
      const r = parseCaptureFile({ ...valid(), category: null });
      assert.equal(r.ok, true);
      // null은 막지 않되 알린다 - 조사 프롬프트의 topic 줄이 빠지고 집필이 기본값으로 간다.
      if (r.ok) assert.ok(r.warnings.some((w) => w.includes("category")));
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
