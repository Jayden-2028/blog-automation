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

  // 사건·사고(incident): 오버라이드의 "§2 문체 표는 참고만 한다"가 §2-1까지 삼키면 안 된다.
  // §2-1은 문체 취향이 아니라 무죄추정·신원보호·자극적 묘사 금지라 구속력이 있어야 한다.
  const incident = buildWritingPrompt({
    job: {
      keyword: "부산 오피스텔 추락사",
      headline: '"가해자 누나는 KBS 드라마 출연 중" 부산 오피스텔 추락사 사건 전말',
      category: "incident",
    },
    researchFilePath: "/r/x.md",
    draftFilePath: "/d/x.md",
    isMedical: false,
    today: "2026-09-04",
  });
  assert(incident.includes("§2-1"), "incident는 writer.md §2-1을 명시적으로 가리켜야 한다");
  assert(
    incident.includes("'참고'가 아니라") || incident.includes("반드시"),
    "§2-1이 구속력을 갖는다고 명시해야 한다"
  );
  // pickStyleRules가 INCIDENT_STYLE_RULES를 실어 보냈는지(개인 톤이 아닌지) 확인한다.
  // 주의: "~더라고요" 같은 단어는 INCIDENT 규칙 안에도 **금지 대상으로** 등장하므로 단순 문자열
  // 검사로는 판별할 수 없다(이 테스트를 처음 쓸 때 실제로 오탐했다). PERSONAL 규칙에만 있는
  // 지시문으로 확인한다.
  assert(incident.includes("1인칭을 쓰지 않는다"), "incident에 개인 톤이 적용되면 안 된다");
  assert(
    !incident.includes("1인칭 화자로 쓴다"),
    "incident에 PERSONAL 규칙(1인칭 화자)이 들어가면 안 된다"
  );
  assert(
    !incident.includes("개인적인 소감이나 생각을 짧게 정리하는 문단"),
    "incident에 개인 소감 문단 지시가 들어가면 안 된다"
  );
  assert(incident.includes("무죄추정"), "incident에 무죄추정 규칙이 있어야 한다");

  // 반대 방향: 일반 카테고리에는 이 예외 문구가 붙지 않아야 한다.
  const normal = buildWritingPrompt({
    job: { keyword: "넷플릭스 신작", headline: null, category: "ott" },
    researchFilePath: "/r/x.md",
    draftFilePath: "/d/x.md",
    isMedical: false,
    today: "2026-09-04",
  });
  assert(!normal.includes("§2-1"), "일반 카테고리에는 incident 예외가 붙으면 안 된다");
  console.log("✅ 사건·사고(incident) 규칙 구속력 + 일반 카테고리 미적용");

  console.log("\n✅ buildWritingPrompt 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
