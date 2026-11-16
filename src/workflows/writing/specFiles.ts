import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
// 원고를 쓰는 모든 경로가 읽을 규격 파일 목록의 **유일한 출처**(2026-09-30).
//
// 왜: 집필(buildWritingPrompt)·수정 재작성(reviseArticleWithFeedback)이 각자 파일 목록을 하드코딩하다
// 보니 서로 어긋났다(배리에이션이 구조·주제배분 문서를 안 읽던 식 - 배리에이션은 2026-09-30 폐지).
// 클라우드(GitHub Actions)와 맥 로컬이 같은 코드 경로를 타므로 이 목록만 같으면 같은 규격의 원고가 나온다.
// 대화형 세션은 `.claude/skills/write-manuscript`가 같은 순서를 안내한다.

export type SpecFile = { path: string; purpose: string };

/** `job.metadata.audience` 값이 이것이면 시니어 집필 규격으로 간다(2026-11-16). */
export const SENIOR_AUDIENCE = "senior";

/**
 * 시니어 표식(2026-11-16). 티스토리 주제 전환 시험의 원고가 "내용은 어렵지 않은데 글을 너무 어렵게 쓴다"는
 * 지적을 받아 **집필 규격만** 갈랐다 - 전체 흐름(조사 → 집필 → 자동 승인 → 통합 알림 → 티스토리 임시저장)은
 * 그대로다.
 *
 * **왜 track이 아니라 audience인가**: track은 어느 봇이 알리고 어느 뷰어에 뜨고 어느 발행 버튼이 붙는지를
 * 정한다. 시니어 원고도 사회 봇·사회 뷰어·티스토리 버튼을 그대로 써야 하므로 track을 새로 만들면 그 셋을
 * 전부 다시 배선해야 한다. audience는 track과 **직교하는 축**이라 집필 규격 한 곳만 갈라진다.
 *
 * **왜 category가 아닌가**: 시니어 job의 category는 `living`이고, 트렌드 경로의 living job이 같은 값을 쓴다.
 * category로 갈라면 관계없는 living 원고까지 문체가 바뀐다(아래 living/tech 트랙이 metadata로 갈린 것과 같은 이유).
 */
export function isSeniorAudience(job: { metadata?: unknown }): boolean {
  const meta = job.metadata && typeof job.metadata === "object" ? (job.metadata as Record<string, unknown>) : null;
  return meta?.audience === SENIOR_AUDIENCE;
}

/**
 * 종합 키워드 입력 툴의 일상(living)·테크(tech) 트랙은 **사회(incident) 문체·규격**을 쓴다(KEYWORD-INPUT-TOOL-2026-10.md A-2).
 *
 * 분기 기준은 category가 아니라 `job.metadata.track`이다: 일상 카테고리는 기존 `living`을 재사용하므로, category로 갈라
 * incident를 주면 **트렌드 경로의 living job까지 문체가 바뀐다.** 입력 툴 job만 metadata.track으로 잡는다
 * (tech 카테고리는 입력 툴에서만 생기므로 category로도 잡는다).
 */
export function specCategoryOf(job: { category?: string | null; metadata?: unknown }): string | null {
  const meta = job.metadata && typeof job.metadata === "object" ? (job.metadata as Record<string, unknown>) : null;
  const track = meta?.track;
  // 시니어 표식이 제일 먼저다. 사건·사고(incident)와 겹칠 일이 없는 주제군이고, 겹친다면 그 job에
  // 표식을 붙인 쪽이 잘못이다 - 시니어 원고에 사망 사건이 들어오면 안 된다.
  if (isSeniorAudience(job)) return "senior";
  if (track === "living" || track === "tech" || job.category === "tech") return "incident";
  return job.category ?? null;
}

/** 카테고리 → 구조·제목 참고 파일. writer.md §2 라우팅과 1:1. */
export function pickStyleFile(category: string | null): string {
  // incident(사건·사고)는 반드시 맨 앞이다. 다른 카테고리로 폴백되면 사망 사건에 개인 블로거 톤이 적용된다.
  if (category === "incident") return "prompts/writing/style/incident.md";
  // 시니어(2026-11-16): 질문 순서·문장 길이·분량 상한이 article-structure/topic-allocation을 이긴다.
  if (category === "senior") return "prompts/writing/style/senior.md";
  // 사용설명서 트랙(개편3): 해외 독자 대상 에버그린 안내. 한글 초고를 쓰고 승인 뒤 영어로 번역된다.
  if (category === KOREAPLAIN_TRACK) return "prompts/writing/style/koreaplain.md";
  // 인물 백과(2026-10-13): incident 뒤에 둔다 - 수사·재판 키워드가 person job으로 들어와도 incident 라우팅이 이긴다.
  if (category === "person") return "prompts/writing/style/person.md";
  if (category === "parenting") return "prompts/writing/style/parenting.md";
  if (category === "entertainment" || category === "ott") return "prompts/writing/style/entertainment.md";
  return "prompts/writing/style/trend.md";
}

export function writingSpecFiles(category: string | null): SpecFile[] {
  const isIncident = category === "incident";
  const isSenior = category === "senior";
  const files: SpecFile[] = [
    { path: "prompts/writing/core-rules.md", purpose: "한 페이지 핵심 규칙 - 금지 표현·어투·마무리·서식. 다른 문서와 부딪히면 이 파일이 이긴다" },
    { path: "prompts/writing/rules/humanize.md", purpose: "저장 직전 자체 윤문 - 의미·사실·인용 불변 철칙 + 명료성 7원칙 + AI 티 제거(스킬 대체, 전 카테고리)" },
    { path: "prompts/writing/writer.md", purpose: "입력 계약·카테고리 라우팅·제목" },
    { path: "prompts/writing/rules/facts-and-hedging.md", purpose: "사실 태도 상세 사례(핵심 원칙은 core-rules §1)" },
    isIncident
      ? { path: "prompts/writing/style/incident.md", purpose: "사건·사고 규격 - 무죄추정·신원 보호. 다른 모든 어투·구조 규칙을 이긴다" }
      : { path: "prompts/writing/style/voice.md", purpose: "공통 어투·어미·인칭 표" },
    {
      path: pickStyleFile(category),
      purpose: isSenior
        ? "시니어 규격 - 질문 순서·한 문장 한 사실·분량 상한. article-structure.md와 topic-allocation.md를 이긴다"
        : "이 카테고리의 제목 기법·흐름",
    },
    { path: "prompts/writing/rules/article-structure.md", purpose: "유형별 소제목 순서" },
    { path: "prompts/writing/rules/topic-allocation.md", purpose: "내적 60%+/외적 40%-/외적의 외적 0" },
    { path: "prompts/writing/rules/output-format.md", purpose: "출력 서식·저장 형식·윤문 계약(코드가 파싱)" },
    { path: "prompts/writing/rules/images.md", purpose: "이미지 마커·획득 방식 판정·프롬프트 쓰는 법(구 output-format §8)" },
    { path: "docs/seo-guide.md", purpose: "제목·키워드·태그 수치 규칙(충돌 시 위 문서가 이긴다)" },
  ];
  // incident는 어투 파일과 카테고리 파일이 같아 중복이 생긴다.
  return files.filter((f, i) => files.findIndex((g) => g.path === f.path) === i);
}

export function formatSpecList(files: SpecFile[]): string[] {
  return files.map((f, i) => `${i + 1}. ${f.path}   (${f.purpose})`);
}
