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
  assert(prompt.includes("prompts/writing/rules/facts-and-hedging.md"), "구조 분리된 사실·헤지 규칙 파일을 Read하라는 지시(2026-09-15)");
  assert(prompt.includes("prompts/writing/rules/output-format.md"), "구조 분리된 출력 형식 계약 파일을 Read하라는 지시(2026-09-15)");
  assert(prompt.includes("docs/seo-guide.md"), "seo-guide.md 참조");
  assert(prompt.includes("/repo/research/한강-불꽃축제-2026.md"), "자료조사 파일 경로가 사실 출처로 명시");
  assert(prompt.includes("/repo/drafts/한강-불꽃축제-2026.md"), "정확한 출력 경로가 박혀 있어야 한다");
  assert(prompt.includes("한강 불꽃축제 2026"), "키워드");
  assert(prompt.includes("2026-09-01"), "오늘 날짜");
  assert(prompt.includes("moai-marketer:content-blog") && prompt.includes("moai-writer:korean-humanize"), "헤드리스 가용 스킬로 오버라이드");
  assert(prompt.includes("**소제목**") && prompt.includes("볼드"), "소제목 볼드 규격 지시(2026-09-06부터)");
  assert(!prompt.includes("`## `"), "더 이상 ## 마크다운 헤더를 쓰라고 하면 안 된다");
  assert(prompt.includes("[IMAGE: 설명]") && prompt.includes("최소 5개"), "이미지 마커 지시");
  assert(prompt.includes("WebSearch를 쓰지 않는다"), "writer는 웹 검색 없음");
  assert(prompt.includes("prompts/writing/style/trend.md"), "living은 trend 문체 참고 파일을 Read하라는 지시가 있어야 한다");
  assert(prompt.includes("prompts/writing/style/voice.md"), "공통 어투 파일 voice.md를 Read하라는 지시(2026-09-16)");
  assert(prompt.includes("바로 위 문단을 한 장으로 요약"), "이미지 프롬프트는 문단 요약이라는 지시(output-format.md §8-1, 2026-09-16)");
  console.log("✅ 규격 참조 + 자료조사 경로 + 정확한 출력 경로 + 파이프라인 오버라이드 + 카테고리별 문체 파일 + 공통 voice");

  const entertainmentPrompt = buildWritingPrompt({
    job: { keyword: "넷플릭스 신작", headline: null, category: "ott" },
    researchFilePath: "/r/e.md",
    draftFilePath: "/d/e.md",
    isMedical: false,
    today: "2026-09-01",
  });
  assert(entertainmentPrompt.includes("prompts/writing/style/entertainment.md"), "ott는 entertainment 문체 참고 파일을 Read해야 한다");

  const parentingPrompt = buildWritingPrompt({
    job: { keyword: "아기 밤중수유 끊는 시기", headline: null, category: "parenting" },
    researchFilePath: "/r/p.md",
    draftFilePath: "/d/p.md",
    isMedical: false,
    today: "2026-09-01",
  });
  assert(parentingPrompt.includes("prompts/writing/style/parenting.md"), "parenting은 parenting 문체 참고 파일을 Read해야 한다");
  assert(
    entertainmentPrompt.includes("prompts/writing/style/voice.md") && parentingPrompt.includes("prompts/writing/style/voice.md"),
    "일반 카테고리는 전부 voice.md를 함께 Read해야 한다(카테고리와 무관한 한 목소리)"
  );

  const noCategoryPrompt = buildWritingPrompt({
    job: { keyword: "미분류 키워드", headline: null, category: null },
    researchFilePath: "/r/n.md",
    draftFilePath: "/d/n.md",
    isMedical: false,
    today: "2026-09-01",
  });
  assert(noCategoryPrompt.includes("prompts/writing/style/trend.md"), "category 없음은 trend를 기본값으로 써야 한다");
  console.log("✅ 카테고리별 문체 파일 분기(entertainment/ott/parenting/living·community·미분류)");

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
  // **가장 중요한 불변식**: 사건·사고가 개인 블로거 톤 파일로 폴백되면 안 된다.
  // 폴백 기본값이 trend.md라, pickStyleFile에서 incident 분기가 빠지면 사망 사건 기사에
  // "친근한 개인 블로거 톤"이 적용된다.
  assert(
    incident.includes("prompts/writing/style/incident.md"),
    "incident는 전용 문체 파일을 Read해야 한다"
  );
  assert(
    !incident.includes("prompts/writing/style/trend.md") &&
      !incident.includes("prompts/writing/style/entertainment.md") &&
      !incident.includes("prompts/writing/style/parenting.md"),
    "incident에 다른 카테고리 문체 파일이 섞이면 안 된다"
  );
  // voice.md(공통 어투)는 incident에 적용하지 않는다(사용자 결정, 2026-09-16) - 습니다체·1인칭 금지는
  // incident.md가 단독으로 정한다.
  assert(!incident.includes("prompts/writing/style/voice.md"), "incident는 voice.md를 Read하면 안 된다");

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

// --- 기획 브리프 주입(2026-09-17) - 소제목 뼈대·unanswered·brief_coverage 지시 -------------------
{
  const withBrief = buildWritingPrompt({
    job: { keyword: "국중박 분장놀이", headline: null, category: "entertainment" },
    researchFilePath: "/tmp/r.md",
    draftFilePath: "/tmp/d.md",
    isMedical: false,
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
  for (const needle of ["Q5. 직접 가서 볼 수 있나", "writer.md §3-1", "`unanswered`", "`brief_coverage`"]) {
    if (!withBrief.includes(needle)) throw new Error(`❌ 브리프 지시가 빠졌습니다: ${needle}`);
  }
  console.log("✅ 기획 브리프 주입 - 소제목 뼈대·커버리지 frontmatter 지시");
}

