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

// --- 기획 브리프 주입(2026-09-17) - 질문·유형 프로파일·미해결 기록 지시가 실린다 ----------------
{
  const withBrief = buildResearchPrompt({
    job: { keyword: "국중박 분장놀이", headline: null, category: "entertainment" },
    baselineSources: [],
    outputPath: "/tmp/r.md",
    today: "2026-09-17",
    brief: {
    type: "event" as const,
    hook: "모델 이혜정이 간돌검 분장으로 결선에 올랐다",
    questions: ["무슨 행사인가", "왜 화제인가", "눈에 띄는 출품작은", "언제 어디서", "직접 가서 볼 수 있나"],
    action: "9월 19일 열린마당 현장 관람",
    autocomplete: ["국중박 분장놀이 결선", "국중박 분장놀이 상금"],
    generatedAt: "2026-09-17T00:00:00.000Z",
  },
  });
  for (const needle of ["Q5. 직접 가서 볼 수 있나", "`event` 프로파일", "Q{n} 미해결", "국중박 분장놀이 상금"]) {
    if (!withBrief.includes(needle)) throw new Error(`❌ 브리프 지시가 빠졌습니다: ${needle}`);
  }
  const withoutBrief = buildResearchPrompt({
    job: { keyword: "k", headline: null, category: null },
    baselineSources: [],
    outputPath: "/tmp/r.md",
    today: "2026-09-17",
  });
  if (withoutBrief.includes("기획 브리프")) throw new Error("❌ 브리프 없는데 브리프 블록이 붙었습니다");
  console.log("✅ 기획 브리프 주입 - 질문·프로파일·미해결 지시, 없으면 생략");
}

