// 집필 단계 "저장 직전 윤문"을 무엇으로 하는지 정하는 게이트(2026-11-15 시험 운영).
//
// `WRITING_HUMANIZE_SKILL`
//   · 비었거나 `self` -> "self" (기본값). rules/humanize.md 체크리스트로 에이전트가 직접 윤문한다(지금까지의 동작).
//   · `im-not-ai` 또는 `skill` -> "skill". 플러그인 스킬 `humanize-korean:humanize-korean`(im-not-ai v2.4.4)을 호출한다.
//
// **롤백은 이 변수 하나다**: repo variable `WRITING_HUMANIZE_SKILL`을 지우면 다음 run부터 옛 동작이다.
// 규격 파일(prompts/writing/rules/*.md)은 어느 모드에서도 건드리지 않는다 - 스킬 모드는 프롬프트 끝에
// override 블록을 덧붙일 뿐이다(buildWritingPrompt / reviseArticleWithFeedback).
//
// 2026-10-15의 "외부 윤문 스킬은 호출하지 않는다" 전제가 바뀐 이유: 그때 막힌 것은 계정 레벨 스킬
// (`anthropic-skills:*`)이라 클라우드 러너에서 로드되지 않았다. 지금 쓰는 것은 GitHub 마켓플레이스
// 플러그인이라 러너에서 `claude plugin install`로 설치된다(job-write.yml이 moai-marketer를 그렇게 설치한다).

export const WRITING_HUMANIZE_SKILL_ENV = "WRITING_HUMANIZE_SKILL";

/** 호출할 스킬 이름(플러그인 `humanize-korean`@im-not-ai 의 스킬 `humanize-korean`). */
export const HUMANIZE_SKILL = "humanize-korean:humanize-korean";

export type HumanizeMode = "self" | "skill";

const SKILL_VALUES = new Set(["im-not-ai", "skill"]);

/** 비었거나 알 수 없는 값은 모두 "self"다 - 오타가 운영 동작을 바꾸지 못하게 한다. */
export function humanizeMode(env: Record<string, string | undefined> = process.env): HumanizeMode {
  const normalized = env[WRITING_HUMANIZE_SKILL_ENV]?.trim().toLowerCase();
  if (!normalized) return "self";
  return SKILL_VALUES.has(normalized) ? "skill" : "self";
}

/** 스킬 모드에서만 윤문 호출 시간이 더해진다(집필·재작성 공통). self 모드는 20분 그대로. */
export const SELF_TIMEOUT_MS = 20 * 60 * 1000;
export const SKILL_TIMEOUT_MS = 28 * 60 * 1000;

export function humanizeAwareTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return humanizeMode(env) === "skill" ? SKILL_TIMEOUT_MS : SELF_TIMEOUT_MS;
}

/** 스킬이 `_workspace/`를 만들고 python3·Glob을 쓰므로, 스킬 모드에서만 이 도구를 더 연다. */
export const HUMANIZE_SKILL_EXTRA_TOOLS = ["Bash", "Glob"] as const;

/** 에이전트가 최종 답에 남기는 윤문 경로 한 줄. 1주일 시험 운영 뒤 이 로그로 실제 사용률을 잰다. */
export type HumanizePath = "skill" | "self-fallback" | "skill-discarded";

const PATH_LINE = /^\s*HUMANIZE:\s*(skill-discarded|skill|self-fallback)\s*$/im;

export function parseHumanizePath(output: string): HumanizePath | null {
  const match = PATH_LINE.exec(output);
  return match ? (match[1].toLowerCase() as HumanizePath) : null;
}

/** 러너 로그에 남기는 한 줄(스킬 모드에서만 호출한다). */
export function humanizePathLogLine(label: string, output: string): string {
  return `[humanize] ${label} path=${parseHumanizePath(output) ?? "unreported"}`;
}

/**
 * 프롬프트 끝에 붙이는 override 블록. 스킬 모드일 때만 호출한다.
 *
 * - `write`: 결과를 draft 파일에 Write한다(저장 직전 윤문).
 * - `revise`: 결과를 `### TITLE` / `### BODY` 마커로 답한다(파일 저장 없음 - 출력 직전 윤문).
 */
export function buildHumanizeOverrideBlock(kind: "write" | "revise"): string[] {
  const where = kind === "write" ? "저장 직전" : "최종 출력 직전";
  const keep = kind === "write" ? "윤문 전 원고를 저장한다" : "윤문 전 원고를 최종본으로 출력한다";
  const logPlace =
    kind === "write"
      ? "최종 답은 두 줄이다: 첫 줄 `HUMANIZE: <경로>`, 마지막 줄 `SAVED: <경로>`(위 지시의 SAVED 줄은 그대로 마지막 줄)."
      : "최종 답의 맨 앞(### TITLE 앞)에 `HUMANIZE: <경로>` 한 줄을 둔다. 그 뒤는 위 출력 형식 그대로다.";
  return [
    "",
    "## 윤문 방식 override (이 실행 한정 - 위 문서와 충돌하면 이 블록이 이긴다)",
    `- ${where} 윤문은 rules/output-format.md §10의 자체 윤문이 아니라 \`Skill(${HUMANIZE_SKILL})\`로 한다.`,
    "  §10과 이 프롬프트 위쪽의 \"외부 윤문 스킬은 호출하지 않는다\"는 문장은 **이 실행에서 무효**다(플러그인으로 설치돼 있다).",
    "- 스킬에 넘기기 전에 아래를 윤문 대상에서 뺀다. 윤문이 끝나면 **원래 자리에 그대로** 되돌린다:",
    "  frontmatter 전체, HTML 주석, `[IMAGE: ...]` / `[IMAGE PROMPT: ...]` 줄.",
    "- 윤문 뒤 **rules/output-format.md §10의 재검증 체크리스트를 전부 수행한다**:",
    "  수치·기관명·제도명·인물명 동일, `[IMAGE: ...]`/`[IMAGE PROMPT: ...]` 마커 쌍 개수 일치,",
    "  `[IMAGE PROMPT: ...]` 줄 완전 동일, 해시태그 개수, 공백 제외 글자 수, facts-and-hedging 금지 표현 재검사.",
    `- 재검증에서 하나라도 어긋나거나 스킬이 변경률 30% 경고를 내면 **윤문본을 버리고 ${keep}.** 윤문본을 고쳐 쓰려 하지 않는다.`,
    "- 스킬 호출 자체가 실패하면(플러그인 미설치·스킬 로드 불가·실행 오류 등) **집필을 중단하지 말고**",
    "  `prompts/writing/rules/humanize.md` 체크리스트로 직접 윤문한 뒤 계속 진행한다. 이 일로 작업을 실패로 끝내지 않는다.",
    "- 윤문을 어느 경로로 했는지 정직하게 적는다: `skill`(스킬 윤문본 채택) / `self-fallback`(스킬 실패로 자체 윤문) /",
    "  `skill-discarded`(스킬은 돌았으나 재검증에서 버림).",
    `  ${logPlace}`,
  ];
}
