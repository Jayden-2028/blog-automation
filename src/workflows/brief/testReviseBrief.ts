// 브리프 재작성 테스트. 실행: npm run test:revise-brief
//
// 지켜야 할 것: ① 실패해도 집필을 막지 않는다(1차로 폴백) ② 리서치 본문이 프롬프트에 실린다
// ③ 안 바꿨으면 안 바꿨다고 한다 ④ type·autocomplete 같은 1차 값은 보존한다.
import { buildRevisePrompt, reviseBriefWithResearch } from "./reviseBriefWithResearch.js";
import type { KeywordBrief } from "./buildKeywordBrief.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const FIRST: KeywordBrief = {
  type: "drama",
  hook: "이준혁·서현우 케미가 화제",
  questions: [
    "무슨 드라마인가",
    "이준혁·서현우 케미가 왜 화제인가",
    "서현우는 왜 당첨금 받고도 퇴사 안 했나",
    "몇 부작인가",
    "어디서 보나",
  ],
  action: "티빙에서 보기",
  autocomplete: ["로또 1등도 출근합니다 몇부작"],
  generatedAt: "2026-09-22T00:00:00Z",
};

const RESEARCH = "13억 당첨자는 공은태(이준혁)이고 양준호(서현우)는 부하직원이다. 시청자 반응은 직장인 현실 공감에 몰렸다.";

const ok = (output: string) => async () => ({ ok: true as const, output, durationMs: 1 });

async function main(): Promise<void> {
  console.log("▶ 브리프 재작성 테스트 시작\n");

  // 1) 프롬프트에 1차 브리프와 리서치가 함께 실린다 - 둘을 비교해야 고칠 수 있다.
  {
    const prompt = buildRevisePrompt({ keyword: "로또 1등도 출근합니다", brief: FIRST, research: RESEARCH });
    assert(prompt.includes(RESEARCH), "리서치 본문이 실려야 한다");
    assert(prompt.includes("이준혁·서현우 케미가 왜 화제인가"), "1차 질문이 실려야 한다");
    assert(prompt.includes("틀린 전제로 만든 질문은"), "틀린 전제를 버리라는 지시가 있어야 한다");
    assert(prompt.includes("CHANGED:"), "무엇을 바꿨는지 물어야 한다");
    console.log("✅ 프롬프트 - 1차 브리프 + 리서치 + 교정 지시");
  }

  // 2) 고쳐 오면 반영하고, 무엇을 고쳤는지 남긴다.
  {
    const out = await reviseBriefWithResearch(
      { keyword: "k", brief: FIRST, research: RESEARCH },
      {
        runClaude: ok(
          [
            "HOOK: 13억 당첨되고도 출근하는 팀장, 직장인 현실 공감",
            "Q1: 무슨 드라마인가",
            "Q2: 시청자들이 어떤 장면에 반응했나",
            "Q3: 당첨자 공은태는 왜 퇴사하지 않았나",
            "Q4: 몇 부작인가",
            "Q5: 어디서 보나",
            "ACTION: 티빙에서 보기",
            "CHANGED: Q2를 케미에서 직장인 공감으로, Q3의 당첨자를 서현우에서 이준혁으로",
          ].join("\n")
        ),
      }
    );
    assert(out.status === "revised", `고쳤으면 revised여야 한다 (${out.status})`);
    assert(out.status === "revised" && out.changed.includes("이준혁"), "무엇을 고쳤는지 남아야 한다");
    assert(out.brief.questions[1].includes("반응"), "질문이 바뀌어야 한다");
    assert(!JSON.stringify(out.brief.questions).includes("서현우는 왜 당첨금"), "틀린 전제 질문이 남으면 안 된다");
    // 1차 값 보존 - 유형은 리서치 프로파일을 이미 골랐고 자동완성은 감사용 원본이다.
    assert(out.brief.type === "drama" && out.brief.autocomplete.length === 1, "type·autocomplete는 1차 것을 유지한다");
    console.log("✅ 재작성 - 질문 교체 + 변경 사유 기록 + 1차 값 보존");
  }

  // 3) 바꿀 것이 없으면 unchanged. 억지로 고쳤다고 하지 않는다.
  {
    const out = await reviseBriefWithResearch(
      { keyword: "k", brief: FIRST, research: RESEARCH },
      {
        runClaude: ok(
          [
            "HOOK: 그대로 둔다",
            "Q1: 무슨 드라마인가",
            "Q2: 시청자 반응은 어땠나",
            "Q3: 당첨자는 왜 퇴사하지 않았나",
            "Q4: 몇 부작인가",
            "Q5: 어디서 보나",
            "ACTION: 없음",
            "CHANGED: 없음",
          ].join("\n")
        ),
      }
    );
    assert(out.status === "unchanged", `안 바꿨으면 unchanged여야 한다 (${out.status})`);
    console.log("✅ 바꿀 것이 없으면 unchanged");
  }

  // 4) 실패해도 예외를 던지지 않는다 - 호출부가 1차를 그대로 쓴다.
  {
    const failed = await reviseBriefWithResearch(
      { keyword: "k", brief: FIRST, research: RESEARCH },
      { runClaude: async () => ({ ok: false as const, error: "타임아웃", durationMs: 1 }) }
    );
    assert(failed.status === "failed", "실행 실패는 failed여야 한다");

    const garbage = await reviseBriefWithResearch(
      { keyword: "k", brief: FIRST, research: RESEARCH },
      { runClaude: ok("무슨 말인지 모르겠는 응답") }
    );
    assert(garbage.status === "failed", "읽을 수 없는 응답도 failed여야 한다");

    const empty = await reviseBriefWithResearch({ keyword: "k", brief: FIRST, research: "   " });
    assert(empty.status === "failed", "리서치가 비면 LLM을 부르지 않고 failed");
    console.log("✅ 실패 처리 - 예외 없이 failed(호출부가 1차로 폴백)");
  }

  console.log("\n🎉 브리프 재작성 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
