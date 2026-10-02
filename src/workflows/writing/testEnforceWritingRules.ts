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

console.log("\n🎉 규칙 집행 테스트 통과");
