// 자료조사 단계(runResearchStage)가 어떤 LLM을 쓸지 결정하는 설정.
//
// 왜 필요한가: 자료조사는 WebSearch/WebFetch를 반복하는 가장 무거운 단계라 Claude 사용량을
// 가장 많이 먹는다(2026-09-02 판단). 집필·OSMU 배리에이션은 블로그 스킬(entertainment/parenting/
// trend-blog-writer)에 강하게 묶여 있어 Claude를 유지하지만, 자료조사는 스킬 의존이 없어
// 다른 프로바이더로 분리해도 톤 품질에 영향이 없다. 그래서 자료조사만 provider를 스위치한다.
//
// **스위치 값이 모델과 실행 위치를 함께 정한다**(2026-11-01 사용자 결정):
//
//   | RESEARCH_PROVIDER | 실행 위치                      | 모델                       |
//   |-------------------|--------------------------------|----------------------------|
//   | claude (기본)     | GitHub Actions job-research.yml | Claude Sonnet (`claude -p`)|
//   | gemini            | GitHub Actions job-research.yml | Gemini (API 호출)          |
//   | codex             | **맥미니 폴러**(job:research-poll) | Codex CLI(GPT-6.1 Sol)   |
//
// 불변식 둘(어기는 경로를 만들면 안 된다):
//   ① 맥미니는 Codex만 돌린다 - Claude 조사가 맥으로 내려가면 맥이 잠들 때 통째로 죽고,
//      사용자가 "Claude 조사는 클라우드에서만"을 명시 요구했다.
//   ② Codex는 Actions에서 돌지 않는다 - Codex CLI와 ChatGPT 구독 로그인이 맥에만 있다.
// 분기 구현은 workflows/research/dispatchResearch.ts 한 곳에 모아 두었다.
//
// 왜 자동 전환이 없는가: 사용자가 Claude 사용량을 직접 보고 스위치를 켠다. Codex는 1건당
// 143k~325k 토큰을 먹어(2026-11-01 실측) Plus 한도로 상시 운용이 안 되므로, "평소 Claude,
// 필요할 때만 Codex"가 운영 전제다.
//
// 기본값은 "claude"다 - 알 수 없는 값도 claude로 떨어진다(오타가 조용히 경로를 바꾸지 않게).

export const RESEARCH_PROVIDERS = ["claude", "gemini", "codex"] as const;
export type ResearchProvider = (typeof RESEARCH_PROVIDERS)[number];

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

/** 알 수 없는 값·빈 값은 모두 claude. 오타로 조사가 엉뚱한 곳에서 돌지 않게 한다. */
export function parseResearchProvider(raw: string | undefined): ResearchProvider {
  const value = (raw ?? "").trim().toLowerCase();
  return (RESEARCH_PROVIDERS as readonly string[]).includes(value) ? (value as ResearchProvider) : "claude";
}

export const RESEARCH_PROVIDER: ResearchProvider = parseResearchProvider(process.env.RESEARCH_PROVIDER);

/**
 * **Gemini 전용** 폴백 스위치(2026-11-01에 범위를 좁혔다). Gemini 호출이 실패(쿼터·네트워크 등)하면
 * 같은 job에 한해 Claude로 1회 폴백한다. 기본 true.
 *
 * Codex에는 적용되지 않는다 - Codex는 Claude 한도가 모자랄 때 켜는 스위치라 실패 시 Claude로
 * 되돌리면 켠 이유가 사라지고, 폴러가 도는 맥에서 Claude 조사를 돌리는 것은 금지다(불변식 ①).
 * Codex 실패는 기존 실패 경로(텔레그램 알림 + 사람이 재시도)로 떨어진다.
 */
export const RESEARCH_FALLBACK_TO_CLAUDE = parseBooleanEnv(process.env.RESEARCH_FALLBACK_TO_CLAUDE, true);

export const GEMINI_RESEARCH_MODEL = process.env.GEMINI_RESEARCH_MODEL?.trim() || "gemini-3.6-flash";
