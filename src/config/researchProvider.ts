// 자료조사 단계(runResearchStage)가 어떤 LLM을 쓸지 결정하는 설정.
//
// 왜 필요한가: 자료조사는 WebSearch/WebFetch를 반복하는 가장 무거운 단계라 Claude 사용량을
// 가장 많이 먹는다(2026-09-02 판단). 집필·OSMU 배리에이션은 블로그 스킬(entertainment/parenting/
// trend-blog-writer)에 강하게 묶여 있어 Claude를 유지하지만, 자료조사는 스킬 의존이 없어
// 다른 프로바이더로 분리해도 톤 품질에 영향이 없다. 그래서 자료조사만 provider를 스위치한다.
//
// 기본값은 "claude"다 - GEMINI_API_KEY를 넣고 RESEARCH_PROVIDER=gemini로 명시적으로 바꾸기
// 전까지는 기존 동작(전부 claude -p)이 그대로 유지된다.

export type ResearchProvider = "claude" | "gemini";

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

export const RESEARCH_PROVIDER: ResearchProvider =
  (process.env.RESEARCH_PROVIDER ?? "claude").trim().toLowerCase() === "gemini" ? "gemini" : "claude";

/** Gemini 호출이 실패(쿼터·네트워크 등)하면 같은 job에 한해 Claude로 자동 폴백할지. 기본 true. */
export const RESEARCH_FALLBACK_TO_CLAUDE = parseBooleanEnv(process.env.RESEARCH_FALLBACK_TO_CLAUDE, true);

export const GEMINI_RESEARCH_MODEL = process.env.GEMINI_RESEARCH_MODEL?.trim() || "gemini-3.6-flash";
