// 윤문 스킬 게이트(WRITING_HUMANIZE_SKILL) 테스트. 실행: npm run test:humanize-mode (외부 호출 없음)
//
// 롤백이 "변수 하나"라는 것이 이 작업의 핵심 제약이다. 그래서 이 테스트는 두 가지를 못박는다:
//  1) 변수가 비었거나 self면 프롬프트·도구·시간이 지금과 같다(override가 새지 않는다).
//  2) 스킬 모드의 override가 안전장치(원문 저장·폴백·재검증)를 빠짐없이 담는다.
import {
  HUMANIZE_SKILL,
  SELF_TIMEOUT_MS,
  SKILL_TIMEOUT_MS,
  humanizeAwareTimeoutMs,
  humanizeMode,
  humanizePathLogLine,
  parseHumanizePath,
} from "../../config/humanizeMode.js";
import { buildWritingPrompt } from "./buildWritingPrompt.js";
import { reviseArticleWithFeedback, REVISION_TIMEOUT_MS } from "./reviseArticleWithFeedback.js";
import { WRITE_TIMEOUT_MS } from "./runArticleJob.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const ENV = "WRITING_HUMANIZE_SKILL";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
}

const baseInput = {
  job: { keyword: "한강 불꽃축제 2026", headline: "여의도 불꽃축제 일정", category: "living" },
  researchFilePath: "/repo/research/a.md",
  draftFilePath: "/repo/drafts/a.md",
  isMedical: false,
  today: "2026-11-15",
};

async function main(): Promise<void> {
  console.log("▶ humanizeMode 테스트 시작\n");

  // 1) 게이트 해석
  const mode = (v: string | undefined) => humanizeMode(v === undefined ? {} : { [ENV]: v });
  assert(mode(undefined) === "self", "미설정은 self(기본값)");
  assert(mode("") === "self", "빈 문자열은 self - 워크플로가 vars.X를 빈 값으로 넘긴다");
  assert(mode("   ") === "self", "공백만이면 self");
  assert(mode("self") === "self", "self");
  assert(mode("SELF") === "self", "대소문자 무시(self)");
  assert(mode("im-not-ai") === "skill", "im-not-ai는 skill");
  assert(mode("skill") === "skill", "skill");
  assert(mode("Skill") === "skill", "대소문자 무시(Skill)");
  assert(mode("  IM-NOT-AI \n") === "skill", "앞뒤 공백·대소문자 무시");
  assert(mode("true") === "self" && mode("im-not-ai2") === "self", "알 수 없는 값은 self - 오타가 운영 동작을 바꾸지 못한다");
  assert(humanizeMode({ [ENV]: "skill" }) === "skill", "env 인자를 직접 받는다");
  console.log("✅ 게이트: 빈값/self=self, im-not-ai/skill=skill, 대소문자·공백 무시, 알 수 없는 값=self");

  // 2) 프롬프트
  const selfPrompt = withEnv(undefined, () => buildWritingPrompt(baseInput));
  const selfExplicit = withEnv("self", () => buildWritingPrompt(baseInput));
  const skillPrompt = withEnv("im-not-ai", () => buildWritingPrompt(baseInput));

  assert(!selfPrompt.includes(HUMANIZE_SKILL), "self 모드(미설정) 프롬프트에 스킬 이름이 들어가면 안 된다");
  assert(!selfPrompt.includes("윤문 방식 override"), "self 모드(미설정) 프롬프트에 override 블록이 들어가면 안 된다");
  assert(!selfExplicit.includes("윤문 방식 override"), "self 모드(명시) 프롬프트에 override 블록이 들어가면 안 된다");
  assert(selfPrompt === selfExplicit, "미설정과 self는 프롬프트가 완전히 같아야 한다 - 변수를 지우면 즉시 옛 동작");
  assert(selfPrompt.includes("외부 윤문 스킬은 호출하지 않는다"), "self 모드의 옛 지시는 그대로 남는다");
  console.log("✅ self 모드: override 블록·스킬 이름 없음, 미설정과 동일");

  assert(skillPrompt.includes("윤문 방식 override"), "skill 모드 프롬프트에 override 블록이 있어야 한다");
  assert(skillPrompt.includes(`Skill(${HUMANIZE_SKILL})`) && HUMANIZE_SKILL === "humanize-korean:humanize-korean", "스킬 이름 호출 지시");
  assert(skillPrompt.includes("이 실행에서 무효**"), "§10의 '외부 윤문 스킬 금지'가 이 실행에서 무효라고 못박아야 한다");
  assert(skillPrompt.startsWith(selfPrompt.split("\n").slice(0, 5).join("\n")), "앞부분은 self 프롬프트와 같다(덧붙이기만 한다)");
  assert(skillPrompt.includes(selfPrompt), "skill 프롬프트는 self 프롬프트를 그대로 포함하고 끝에 덧붙인다");
  assert(
    skillPrompt.includes("frontmatter 전체") && skillPrompt.includes("HTML 주석") && skillPrompt.includes("[IMAGE PROMPT: ...]"),
    "윤문 제외 대상(frontmatter·HTML 주석·IMAGE 줄) 지시"
  );
  assert(skillPrompt.includes("재검증 체크리스트를 전부 수행"), "§10 재검증 체크리스트를 전부 수행하라는 지시");
  assert(
    skillPrompt.includes("윤문본을 버리고") && skillPrompt.includes("윤문 전 원고를 저장한다") && skillPrompt.includes("30% 경고"),
    "재검증 실패·30% 경고 시 윤문본을 버리고 윤문 전 원고를 저장하라는 지시"
  );
  assert(
    skillPrompt.includes("prompts/writing/rules/humanize.md") && skillPrompt.includes("집필을 중단하지 말고") && skillPrompt.includes("self-fallback"),
    "스킬 호출 실패 시 humanize.md 자체 윤문으로 폴백하고 집필을 중단하지 않는다는 지시"
  );
  assert(
    skillPrompt.includes("HUMANIZE: <경로>") && skillPrompt.includes("`skill`") && skillPrompt.includes("self-fallback"),
    "윤문 경로 한 줄 로그 지시"
  );
  assert(skillPrompt.trimEnd().split("\n").some((l) => l.includes(`SAVED: ${baseInput.draftFilePath}`)), "SAVED 줄 지시는 유지된다");
  // 규격 목록은 두 모드가 같다(폴백이 humanize.md를 읽어야 한다).
  assert(selfPrompt.includes("prompts/writing/rules/humanize.md") && skillPrompt.includes("2. prompts/writing/rules/humanize.md"), "두 모드 모두 humanize.md를 규격으로 읽는다");
  console.log("✅ skill 모드: override 블록 + 스킬 이름 + 제외 대상 + 재검증 + 원문 저장 + 폴백 + 경로 로그");

  // 3) 시간·도구
  assert(WRITE_TIMEOUT_MS === 20 * 60 * 1000 && REVISION_TIMEOUT_MS === 20 * 60 * 1000, "self 기준 상수는 20분 그대로");
  assert(humanizeAwareTimeoutMs({}) === SELF_TIMEOUT_MS && SELF_TIMEOUT_MS === 20 * 60 * 1000, "self 모드 시한 20분");
  assert(humanizeAwareTimeoutMs({ [ENV]: "skill" }) === SKILL_TIMEOUT_MS && SKILL_TIMEOUT_MS === 28 * 60 * 1000, "skill 모드 시한 28분");

  const revise = async (value: string | undefined): Promise<string> => {
    let captured = "";
    await withEnv(value, () =>
      reviseArticleWithFeedback({
        keyword: "k",
        category: "living",
        originalTitle: "t",
        originalBody: "본문",
        feedback: "더 쉽게",
        enforceRules: false,
        generate: async (prompt) => {
          captured = prompt;
          return { ok: false, error: "stop" } as never;
        },
      })
    );
    return captured;
  };
  const reviseSelf = await revise(undefined);
  const reviseSkill = await revise("skill");
  assert(!reviseSelf.includes("윤문 방식 override") && !reviseSelf.includes(HUMANIZE_SKILL), "수정 재작성 self 모드에는 override가 없다");
  assert(reviseSkill.includes("윤문 방식 override") && reviseSkill.includes(HUMANIZE_SKILL), "수정 재작성 skill 모드에는 override가 있다");
  assert(reviseSkill.includes("윤문본을 버리고") && reviseSkill.includes("집필을 중단하지 말고"), "수정 재작성 override에도 원문 유지·폴백 지시가 있다");
  assert(reviseSkill.includes("### TITLE") && reviseSkill.includes("HUMANIZE: <경로>"), "수정 재작성 override는 마커 출력 형식과 경로 로그를 함께 안내한다");
  console.log("✅ 시간(self 20분/skill 28분) + 수정 재작성 프롬프트 게이트");

  // 4) 경로 로그 파싱
  assert(parseHumanizePath("HUMANIZE: skill\nSAVED: /x") === "skill", "HUMANIZE: skill 파싱");
  assert(parseHumanizePath("HUMANIZE: self-fallback\nSAVED: /x") === "self-fallback", "self-fallback 파싱");
  assert(parseHumanizePath("HUMANIZE: skill-discarded\nSAVED: /x") === "skill-discarded", "skill-discarded는 skill과 구분된다");
  assert(parseHumanizePath("SAVED: /x") === null, "줄이 없으면 null");
  assert(humanizePathLogLine("job=1", "SAVED: /x") === "[humanize] job=1 path=unreported", "보고 누락도 로그에 드러난다");
  assert(humanizePathLogLine("job=1", "HUMANIZE: skill\nSAVED: /x") === "[humanize] job=1 path=skill", "로그 한 줄 형식");
  console.log("✅ 경로 로그 파싱");

  console.log("\n✅ humanizeMode 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
