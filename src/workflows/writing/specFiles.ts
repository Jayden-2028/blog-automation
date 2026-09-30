// 원고를 쓰는 모든 경로가 읽을 규격 파일 목록의 **유일한 출처**(2026-09-30).
//
// 왜: 집필(buildWritingPrompt)·수정 재작성(reviseArticleWithFeedback)이 각자 파일 목록을 하드코딩하다
// 보니 서로 어긋났다(배리에이션이 구조·주제배분 문서를 안 읽던 식 - 배리에이션은 2026-09-30 폐지).
// 클라우드(GitHub Actions)와 맥 로컬이 같은 코드 경로를 타므로 이 목록만 같으면 같은 규격의 원고가 나온다.
// 대화형 세션은 `.claude/skills/write-manuscript`가 같은 순서를 안내한다.

export type SpecFile = { path: string; purpose: string };

/** 카테고리 → 구조·제목 참고 파일. writer.md §2 라우팅과 1:1. */
export function pickStyleFile(category: string | null): string {
  // incident(사건·사고)는 반드시 맨 앞이다. 다른 카테고리로 폴백되면 사망 사건에 개인 블로거 톤이 적용된다.
  if (category === "incident") return "prompts/writing/style/incident.md";
  if (category === "parenting") return "prompts/writing/style/parenting.md";
  if (category === "entertainment" || category === "ott") return "prompts/writing/style/entertainment.md";
  return "prompts/writing/style/trend.md";
}

export function writingSpecFiles(category: string | null): SpecFile[] {
  const isIncident = category === "incident";
  const files: SpecFile[] = [
    { path: "prompts/writing/core-rules.md", purpose: "한 페이지 핵심 규칙 - 금지 표현·어투·마무리·서식. 다른 문서와 부딪히면 이 파일이 이긴다" },
    { path: "prompts/writing/writer.md", purpose: "입력 계약·카테고리 라우팅·제목" },
    { path: "prompts/writing/rules/facts-and-hedging.md", purpose: "사실 태도 상세 사례(핵심 원칙은 core-rules §1)" },
    isIncident
      ? { path: "prompts/writing/style/incident.md", purpose: "사건·사고 규격 - 무죄추정·신원 보호. 다른 모든 어투·구조 규칙을 이긴다" }
      : { path: "prompts/writing/style/voice.md", purpose: "공통 어투·어미·인칭 표" },
    { path: pickStyleFile(category), purpose: "이 카테고리의 제목 기법·흐름" },
    { path: "prompts/writing/rules/article-structure.md", purpose: "유형별 소제목 순서" },
    { path: "prompts/writing/rules/topic-allocation.md", purpose: "내적 60%+/외적 40%-/외적의 외적 0" },
    { path: "prompts/writing/rules/output-format.md", purpose: "출력 서식·이미지 마커 계약(코드가 파싱)" },
    { path: "docs/seo-guide.md", purpose: "제목·키워드·태그 수치 규칙(충돌 시 위 문서가 이긴다)" },
  ];
  // incident는 어투 파일과 카테고리 파일이 같아 중복이 생긴다.
  return files.filter((f, i) => files.findIndex((g) => g.path === f.path) === i);
}

export function formatSpecList(files: SpecFile[]): string[] {
  return files.map((f, i) => `${i + 1}. ${f.path}   (${f.purpose})`);
}
