// buildWritingPrompt 테스트. Node가 조율만 하는지(규격은 writer.md/seo-guide 참조) 확인.

import { buildWritingPrompt } from "./buildWritingPrompt.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ buildWritingPrompt 테스트 시작\n");

  const prompt = buildWritingPrompt({
    job: { keyword: "한강 불꽃축제 2026", headline: "여의도 불꽃축제 일정", category: "living" },
    researchFilePath: "/repo/research/한강-불꽃축제-2026.md",
    draftFilePath: "/repo/drafts/한강-불꽃축제-2026.md",
    isMedical: false,
    today: "2026-09-01",
  });

  assert(prompt.includes("prompts/writing/writer.md"), "writer.md를 Read하라는 지시");
  assert(prompt.includes("docs/seo-guide.md"), "seo-guide.md 참조");
  assert(prompt.includes("/repo/research/한강-불꽃축제-2026.md"), "자료조사 파일 경로가 사실 출처로 명시");
  assert(prompt.includes("/repo/drafts/한강-불꽃축제-2026.md"), "정확한 출력 경로가 박혀 있어야 한다");
  assert(prompt.includes("한강 불꽃축제 2026"), "키워드");
  assert(prompt.includes("2026-09-01"), "오늘 날짜");
  assert(prompt.includes("moai-marketer:content-blog") && prompt.includes("moai-writer:korean-humanize"), "헤드리스 가용 스킬로 오버라이드");
  assert(prompt.includes("## ") && prompt.includes("마크다운 헤더"), "소제목 ## 유지 오버라이드");
  assert(prompt.includes("[IMAGE: 설명]") && prompt.includes("최소 5개"), "이미지 마커 지시");
  assert(prompt.includes("WebSearch를 쓰지 않는다"), "writer는 웹 검색 없음");
  assert(prompt.includes("1인칭"), "living은 EDITORIAL 톤(1인칭 쓰지 않는다)이 프롬프트에 있어야 한다");
  console.log("✅ 규격 참조 + 자료조사 경로 + 정확한 출력 경로 + 파이프라인 오버라이드 + 카테고리 톤");

  // 의학 주제면 그 사실을 프롬프트에 알린다.
  const medical = buildWritingPrompt({
    job: { keyword: "아기 셔더링 어택", headline: null, category: "parenting" },
    researchFilePath: "/r/x.md",
    draftFilePath: "/d/x.md",
    isMedical: true,
    today: "2026-09-01",
  });
  assert(medical.includes("의학 정보를 다룬다"), "의학 주제 안내");
  console.log("✅ 의학 주제 플래그 전달");

  console.log("\n✅ buildWritingPrompt 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
