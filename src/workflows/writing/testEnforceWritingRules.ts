// 저장 직전 규칙 집행 테스트. 실행: npm run test:enforce-rules  (외부 호출 없음 - fixer 주입)
import { applyDeterministicFixes, enforceWritingRules, findRuleViolations } from "./enforceWritingRules.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ ${msg}`);
}

// 1) 결정적 교정 - 댓글 유도 문장과 시점 표기
{
  const body = [
    "지원금은 2026년 8월 기준 30만 원입니다. 신청은 온라인으로 합니다.",
    "",
    "여기 정리한 내용은 2026년 9월 18일 기준입니다.",
    "",
    "**신청 방법**",
    "정부24에서 신청합니다. 여러분은 어떻게 생각하시나요? 댓글로 남겨주세요.",
    "",
    "#지원금 #신청",
  ].join("\n");
  const fixed = applyDeterministicFixes(body);
  assert(fixed.body.includes("지원금은 30만 원입니다."), `시점 표기만 지워야 한다 (실제: ${fixed.body})`);
  assert(!fixed.body.includes("기준"), "기준 시점 문장이 남았다");
  assert(!fixed.body.includes("여러분은"), "댓글 유도가 남았다");
  assert(fixed.body.includes("정부24에서 신청합니다."), "정상 문장이 지워졌다");
  assert(fixed.body.includes("**신청 방법**") && fixed.body.includes("#지원금"), "소제목·해시태그는 보존");
  console.log("✅ 결정적 교정: 댓글 유도·기준 시점 삭제, 나머지 보존");
}

// 1-1) 올해 날짜의 연도만 뗀다(2026-10-02). 다른 연도·연도 단독 표기는 그대로 둔다.
{
  const now = new Date("2026-10-02T09:00:00+09:00");
  const body = [
    "2026년 10월 1일에 SNS에서 퍼졌습니다. 2026년 10월 9일은 한글날입니다.",
    "한글날은 1990년 공휴일에서 빠졌고 2012년 12월 28일에 복원됐습니다.",
    "2026년 공휴일은 70일입니다.",
  ].join("\n");
  const fixed = applyDeterministicFixes(body, now);
  assert(fixed.body.includes("10월 1일에 SNS에서 퍼졌습니다."), `올해 연도를 떼야 한다 (${fixed.body})`);
  assert(fixed.body.includes("10월 9일은 한글날입니다."), "한 줄에 두 번 나와도 둘 다 뗀다");
  assert(!fixed.body.includes("2026년 10월"), "올해 연도+월 표기가 남으면 안 된다");
  assert(fixed.body.includes("1990년 공휴일에서 빠졌고 2012년 12월 28일에 복원"), "다른 연도는 그대로 둔다");
  assert(fixed.body.includes("2026년 공휴일은 70일입니다."), "연도 단독 표기는 날짜가 아니라 그대로 둔다");
  assert(fixed.removed.some((r) => r.includes("올해 연도")), "무엇을 뗐는지 남겨야 한다");
  console.log("✅ 결정적 교정: 올해 날짜의 연도만 제거, 다른 연도·연도 단독 보존");
}

// 2) 정상 원고는 손대지 않는다
{
  const clean = "지원금은 30만 원입니다. 지급일은 8월 27일입니다.\n\n**신청 방법**\n정부24에서 신청합니다.";
  const fixed = applyDeterministicFixes(clean);
  assert(fixed.body === clean && fixed.removed.length === 0, `정상 원고가 바뀌었다: ${fixed.body}`);
  assert(findRuleViolations(clean).length === 0, "정상 원고에서 위반이 나왔다");
  console.log("✅ 정상 원고는 그대로");
}

// 3) 위반 탐지 - 참고 자료와 소제목·이미지 마커는 제외
{
  const body = [
    "말한 것으로 보도됐습니다.",
    "[IMAGE: 보도됐습니다 장면]",
    "**요금은 아직 공개되지 않았습니다**",
    "저희도 그랬거든요.",
    "",
    "## 참고 자료",
    "- [보도됐습니다](https://x)",
  ].join("\n");
  const v = findRuleViolations(body);
  assert(v.length === 2, `위반 2건이어야 한다 (실제 ${v.length}: ${JSON.stringify(v)})`);
  console.log("✅ 위반 탐지: 본문 문장만, 마커·소제목·참고 자료 제외");
}

// 4) 에이전트 교정 - 성공, 실패(위반 안 줄어듦), 마커 수 변경, 호출 실패
const bad = "말한 것으로 보도됐습니다. 지원금은 30만 원입니다.\n\n[IMAGE: 창구 — 웹 검색]\n[IMAGE PROMPT: 주민센터 창구]\n\n저희도 그랬거든요.";
{
  const ok = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({
      ok: true,
      output: "### BODY\n그는 이렇게 말했습니다. 지원금은 30만 원입니다.\n\n[IMAGE: 창구 — 웹 검색]\n[IMAGE PROMPT: 주민센터 창구]\n\n저희도 그랬어요.",
      durationMs: 1,
    }),
  });
  assert(ok.agentApplied && ok.violationsAfter === 0, "성공한 교정이 적용돼야 한다");

  const noGain = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({ ok: true, output: `### BODY\n${bad}`, durationMs: 1 }),
  });
  assert(!noGain.agentApplied && noGain.body === bad, "위반이 안 줄면 원본을 유지해야 한다");

  const lostMarker = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({ ok: true, output: "### BODY\n지원금은 30만 원입니다. 저희도 그랬어요. 지원금 안내를 길게 적습니다. 신청은 온라인으로 합니다.", durationMs: 1 }),
  });
  assert(!lostMarker.agentApplied, "마커가 사라진 결과는 버려야 한다");

  const failed = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({ ok: false, error: "timeout", durationMs: 1 }),
  });
  assert(!failed.agentApplied && failed.body === bad, "호출 실패는 원본 유지(fail-open)");

  let called = false;
  const clean = await enforceWritingRules({
    body: "지원금은 30만 원입니다.",
    category: null,
    runFixer: async () => {
      called = true;
      return { ok: true, output: "", durationMs: 1 };
    },
  });
  assert(!called && !clean.agentApplied, "위반이 없으면 에이전트를 부르지 않는다");
  console.log("✅ 에이전트 교정: 적용 / 위반 미감소 폐기 / 마커 변경 폐기 / 호출 실패 fail-open / 위반 없으면 미호출");
}

// 5) person 분기(2026-10-15) - 허용 어미(~거든요·~고요)는 교정 대상이 아니다. 나머지 어미·타 카테고리는 기존대로.
{
  const personBody = "두 작품이 같은 시기에 겹쳤거든요. 일정이 빠듯했고요.\n\n[IMAGE: 장면 — 웹 검색]";
  assert(findRuleViolations(personBody, "person").length === 0, "person의 거든요·고요는 위반이 아니다");
  assert(findRuleViolations(personBody, "entertainment").length === 2, "타 카테고리의 거든요·고요는 기존대로 위반(문장 2개)");
  assert(findRuleViolations(personBody).length === 2, "category 미지정도 기존대로 위반(문장 2개)");
  assert(findRuleViolations("분위기가 좋네요. 그랬잖아요.", "person").length === 2, "person도 네요·잖아요는 위반(문장 2개)");

  let called = false;
  const personRun = await enforceWritingRules({
    body: personBody,
    category: "person",
    runFixer: async () => {
      called = true;
      return { ok: true, output: "", durationMs: 1 };
    },
  });
  assert(!called && !personRun.agentApplied && personRun.body === personBody && personRun.violationsBefore === 0, "person 허용 어미만 있으면 에이전트를 부르지 않고 원고를 바꾸지 않는다");

  let prompt = "";
  await enforceWritingRules({
    body: "분위기가 좋네요. 두 작품이 겹쳤거든요.",
    category: "person",
    runFixer: async (p: string) => {
      prompt = p;
      return { ok: false, error: "stub", output: "", durationMs: 1 } as never;
    },
  });
  assert(prompt.includes("좋네요") && !prompt.includes("] 두 작품이 겹쳤거든요"), "person 교정 목록에는 금지 어미 문장만 들어간다");
  assert(prompt.includes("`~거든요`·`~고요`를 허용"), "person 교정 지시에 허용 어미 안내가 있다");
  console.log("✅ person 분기: 허용 어미 미교정 / 금지 어미 교정 / 타 카테고리 기존대로");
}

// 6) 직접 인용(따옴표 안)은 전 카테고리에서 구어 어미 교정 대상이 아니다. 인용 밖은 그대로 잡는다. 따옴표가 문장 경계를 넘어도 동일.
{
  assert(findRuleViolations('그는 "저희도 그랬잖아요. 처음엔 어렵더라고요."라고 말했습니다.', "living").length === 0, "인용 안 어미는 위반이 아니다(문장 경계를 넘는 인용 포함)");
  assert(findRuleViolations('그는 "그랬잖아요."라고 했는데 본문은 좋네요.', "living").length === 1, "인용 밖 어미는 기존대로 위반");
  assert(findRuleViolations("그는 “겹쳤거든요.”라고 했습니다.", "entertainment").length === 0, "큰따옴표(곡선) 인용도 제외");
  console.log("✅ 직접 인용 안 어미 제외(문장 경계 넘는 인용 포함), 인용 밖은 기존대로");
}

console.log("\n🎉 규칙 집행 테스트 통과");
