// buildResearchPrompt 테스트. Node가 조율만 하는지(규격은 researcher.md 참조, 컨텍스트+경로만 주입) 확인.

import { buildResearchPrompt } from "./buildResearchPrompt.js";
import type { SourceInsert } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ buildResearchPrompt 테스트 시작\n");

  const baseline: SourceInsert[] = [
    { job_id: "j1", title: "질병관리청 안내", url: "https://kdca.go.kr/a", authority: "official" },
    { job_id: "j1", title: "맘카페 후기", url: "https://cafe.naver.com/b", authority: "community" },
  ];

  const prompt = buildResearchPrompt({
    job: { keyword: "아기 밤중수유 끊는 시기", headline: "밤중수유 언제 끊나", category: "parenting" },
    baselineSources: baseline,
    outputPath: "/repo/research/아기-밤중수유-끊는-시기.md",
    today: "2026-09-01",
  });

  assert(prompt.includes("prompts/research/researcher.md"), "규격 문서를 Read하라는 지시가 있어야 한다");
  assert(prompt.includes("아기 밤중수유 끊는 시기"), "키워드가 프롬프트에 있어야 한다");
  assert(prompt.includes("2026-09-01"), "오늘 날짜가 프롬프트에 있어야 한다");
  assert(prompt.includes("parenting"), "topic(category)이 프롬프트에 있어야 한다");
  assert(prompt.includes("/repo/research/아기-밤중수유-끊는-시기.md"), "정확한 출력 경로가 박혀 있어야 한다");
  assert(prompt.includes("https://kdca.go.kr/a") && prompt.includes("https://cafe.naver.com/b"), "baseline 출처 URL이 나열돼야 한다");
  assert(prompt.includes("[official]") && prompt.includes("[community]"), "baseline 등급이 표시돼야 한다");
  assert(prompt.includes("WebSearch"), "빈칸 보강에 WebSearch를 쓰라는 지시가 있어야 한다");
  console.log("✅ 규격 참조 + 컨텍스트 + baseline + 정확한 경로 주입");

  // baseline이 비면 그 사실을 알린다.
  const empty = buildResearchPrompt({
    job: { keyword: "x", headline: null, category: null },
    baselineSources: [],
    outputPath: "/repo/research/x.md",
    today: "2026-09-01",
  });
  assert(empty.includes("없음") && empty.includes("직접 조사"), "baseline이 비면 '전부 직접 조사' 안내");
  console.log("✅ baseline 비었을 때 안내");

  console.log("\n✅ buildResearchPrompt 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
