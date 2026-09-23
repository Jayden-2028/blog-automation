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


// --- 자율 모드(2026-09-23 검증) - researcher-auto.md 하나만 읽히고 목록 지시가 전부 빠진다 ------
{
  const auto = buildResearchPrompt({
    job: { keyword: "허남준 고윤정 티저", headline: "고윤정 만났다", category: "entertainment" },
    baselineSources: [],
    outputPath: "/tmp/r.md",
    today: "2026-09-23",
    // 브리프가 넘어와도 자율 모드에서는 무시해야 한다 - 재실행 job의 metadata에 남아 있을 수 있다.
    brief: {
      type: "celebrity" as const,
      hook: "이미 아는 사이였다",
      questions: ["누구인가", "왜 화제인가", "언제 공개되나", "어디서 보나", "무엇을 할까"],
      action: "계정 팔로우",
      autocomplete: ["너를 만난 계절"],
      generatedAt: "2026-09-23T00:00:00.000Z",
    },
    mode: "auto",
  });

  for (const needle of [
    "prompts/research/researcher-auto.md",
    "허남준 고윤정 티저",
    "조사 항목 목록은 주지 않는다",
    "## 전체 출처 목록",
    "## 캡처할 페이지",
    "SAVED:",
  ]) {
    if (!auto.includes(needle)) throw new Error(`❌ 자율 모드 프롬프트에 빠졌습니다: ${needle}`);
  }
  // spec 규격과 브리프가 새어 들어가면 자율 모드가 아니다.
  for (const forbidden of ["prompts/research/researcher.md", "기획 브리프", "§4-1", "7개 카테고리", "Q{n} 미해결"]) {
    if (auto.includes(forbidden)) throw new Error(`❌ 자율 모드에 spec 지시가 남았습니다: ${forbidden}`);
  }
  // 기본값은 여전히 spec이다 - mode를 안 주면 기존 동작.
  const spec = buildResearchPrompt({
    job: { keyword: "k", headline: null, category: null },
    baselineSources: [],
    outputPath: "/tmp/r.md",
    today: "2026-09-23",
  });
  if (!spec.includes("prompts/research/researcher.md")) throw new Error("❌ 기본값이 spec이 아닙니다");
  console.log("✅ 자율 모드 - auto 규격만 로드, 브리프·수집 목록 제거, 기본값은 spec 유지");
}

// --- 인스타 원본 자료가 두 모드 모두에 실린다(2026-09-24) ---------------------------------------
// auto 분기에 빠져 있었다. 사용자가 직접 고른 게시물이 1차 근거인데 조용히 사라지면
// 그 job은 근거 없이 조사된다.
{
  const CONTEXT = "@whyissuenow 게시물: 카페 대란 현장 사진 3장 + 캡션 원문";
  for (const mode of ["spec", "auto"] as const) {
    const prompt = buildResearchPrompt({
      job: { keyword: "카페 대란", headline: null, category: "community" },
      baselineSources: [],
      outputPath: "/tmp/r.md",
      today: "2026-09-24",
      sourceContext: CONTEXT,
      mode,
    });
    if (!prompt.includes(CONTEXT)) throw new Error(`❌ ${mode} 모드에 인스타 원본 자료가 빠졌습니다`);
  }
  // 없으면 블록 자체가 붙지 않는다.
  const without = buildResearchPrompt({
    job: { keyword: "k", headline: null, category: null },
    baselineSources: [],
    outputPath: "/tmp/r.md",
    today: "2026-09-24",
    mode: "auto",
  });
  if (without.includes("원본 자료")) throw new Error("❌ 원본 자료가 없는데 블록이 붙었습니다");
  console.log("✅ 인스타 원본 자료 - spec·auto 두 모드 모두 주입, 없으면 생략");
}
