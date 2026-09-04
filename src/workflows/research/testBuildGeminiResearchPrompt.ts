// buildGeminiResearchPrompt 테스트. researcher.md 전문이 인라인되는지, Claude 전용(Read/Write)
// 지시가 아니라 Gemini 전용(파일 저장 없이 텍스트만 출력) 오버라이드가 들어가는지 확인한다.
// 실제 Gemini API는 부르지 않는다(네트워크·과금 없음) - 프롬프트 문자열만 검증.

import { buildGeminiResearchPrompt } from "./buildGeminiResearchPrompt.js";
import type { SourceInsert } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const FAKE_SPEC = [
  "## 2. 절대 규칙 (위반 시 산출물 폐기)",
  "1. 확인 안 된 내용은 쓰지 않는다.",
  "## 7. 출력 파일 규격",
  "이미 있으면 덮어쓰지 말고 -날짜를 붙여 저장한다.",
].join("\n");

function main(): void {
  console.log("▶ buildGeminiResearchPrompt 테스트 시작\n");

  const baseline: SourceInsert[] = [
    { job_id: "j1", title: "질병관리청 안내", url: "https://kdca.go.kr/a", authority: "official" },
  ];

  const prompt = buildGeminiResearchPrompt(
    {
      job: { keyword: "아기 밤중수유 끊는 시기", headline: "밤중수유 언제 끊나", category: "parenting" },
      baselineSources: baseline,
      today: "2026-09-02",
    },
    FAKE_SPEC
  );

  assert(prompt.includes(FAKE_SPEC), "researcher.md 전문이 그대로 인라인돼야 한다");
  assert(prompt.includes("아기 밤중수유 끊는 시기"), "키워드가 프롬프트에 있어야 한다");
  assert(prompt.includes("2026-09-02"), "오늘 날짜가 프롬프트에 있어야 한다");
  assert(prompt.includes("https://kdca.go.kr/a"), "baseline URL이 나열돼야 한다");
  assert(prompt.includes("Read/Write 도구가 없다"), "Gemini에 도구가 없다는 사실이 명시돼야 한다");
  assert(prompt.includes("코드블록"), "코드펜스 금지 지시가 있어야 한다");
  assert(!/^\s*```/.test(prompt), "프롬프트 자체가 코드펜스로 시작하면 안 된다");
  console.log("✅ 규격 인라인 + 컨텍스트 + Gemini 전용 오버라이드 확인");

  const empty = buildGeminiResearchPrompt(
    { job: { keyword: "x", headline: null, category: null }, baselineSources: [], today: "2026-09-02" },
    FAKE_SPEC
  );
  assert(empty.includes("없음") && empty.includes("직접 검색"), "baseline이 비면 '전부 직접 검색' 안내");
  console.log("✅ baseline 비었을 때 안내");

  console.log("\n✅ buildGeminiResearchPrompt 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
