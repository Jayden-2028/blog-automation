// reviseArticleWithFeedback 테스트. generate를 주입해 실제 claude -p 호출 없이 파싱·검증 로직만
// 확인한다(generateArticleVariant.ts의 테스트 부재와 달리, 이 모듈은 마커 파싱이 핵심이라 여기서는
// 순수 로직을 검증해둔다).

import { parseBlockedReason, parseRevisionOutput, REVISION_BLOCKED_MARKER, reviseArticleWithFeedback } from "./reviseArticleWithFeedback.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const baseInput = {
  keyword: "테스트 키워드",
  category: "living",
  originalTitle: "기존 제목",
  originalBody: "본문 문단입니다.\n\n#태그1 #태그2",
  feedback: "제목을 더 짧게 해줘",
};

async function main(): Promise<void> {
  console.log("▶ reviseArticleWithFeedback 테스트 시작\n");

  // 1) 정상 출력 - TITLE/BODY 마커를 정확히 파싱한다.
  {
    const raw = ["### TITLE", "짧은 제목", "### BODY", "수정된 본문입니다.\n\n#태그1 #태그2".repeat(10)].join("\n");
    const parsed = parseRevisionOutput(raw, "fallback");
    assert(parsed.title === "짧은 제목", `제목 파싱 실패 (${parsed.title})`);
    assert(parsed.body.startsWith("수정된 본문"), `본문 파싱 실패 (${parsed.body.slice(0, 20)})`);
    console.log("✅ TITLE/BODY 마커 정상 파싱");
  }

  // 2) TITLE 마커가 없으면 fallbackTitle을 쓴다.
  {
    const raw = `### BODY\n${"본문".repeat(200)}`;
    const parsed = parseRevisionOutput(raw, "기존 제목");
    assert(parsed.title === "기존 제목", "TITLE 마커 없으면 fallback을 써야 한다");
    console.log("✅ TITLE 마커 없음 -> fallbackTitle 사용");
  }

  // 3) 마커를 아예 안 지킨 대화체 응답 -> failed 처리(generateArticleVariant.ts와 같은 안전장치).
  {
    const result = await reviseArticleWithFeedback({
      ...baseInput,
      generate: async () => ({ ok: true, output: "죄송합니다, 정보가 부족합니다.", durationMs: 1 }),
    });
    assert(result.status === "failed" && result.error.includes("마커 형식"), `마커 누락 시 failed여야 한다 (${JSON.stringify(result)})`);
    console.log("✅ 마커 누락 응답 -> failed(대화체 오인식 방지)");
  }

  // 4) 본문이 너무 짧으면(300자 미만) failed 처리.
  {
    const result = await reviseArticleWithFeedback({
      ...baseInput,
      generate: async () => ({ ok: true, output: "### TITLE\n제목\n### BODY\n짧음", durationMs: 1 }),
    });
    assert(result.status === "failed" && result.error.includes("너무 짧습니다"), "짧은 본문은 failed여야 한다");
    console.log("✅ 본문 300자 미만 -> failed");
  }

  // 5) 헤드리스 호출 자체가 실패하면 그대로 전파한다.
  {
    const result = await reviseArticleWithFeedback({
      ...baseInput,
      generate: async () => ({ ok: false, error: "타임아웃", durationMs: 1 }),
    });
    assert(result.status === "failed" && result.error === "타임아웃", "generate 실패를 그대로 전파해야 한다");
    console.log("✅ generate 실패 -> 그대로 전파");
  }

  // 6) 정상 케이스 - status success + 소요시간 포함.
  {
    const longBody = "수정된 본문 문단입니다. ".repeat(30);
    const result = await reviseArticleWithFeedback({
      ...baseInput,
      generate: async () => ({ ok: true, output: `### TITLE\n짧은 제목\n### BODY\n${longBody}`, durationMs: 1234 }),
    });
    assert(result.status === "success", "정상 마커 응답은 success여야 한다");
    if (result.status === "success") {
      assert(result.revised.title === "짧은 제목", "제목이 반영돼야 한다");
      assert(result.revised.body.trim() === longBody.trim(), "본문이 그대로 반영돼야 한다");
    }
    console.log("✅ 정상 케이스 -> success + 제목/본문 반영");
  }

  // 7) 조사 기록을 주면 사실 출처로 프롬프트에 들어간다(2026-11-06). 주지 않으면 "기존 원고뿐"이 그대로다.
  {
    let withResearch = "";
    const longBody = "수정된 본문 문단입니다. ".repeat(30);
    await reviseArticleWithFeedback({
      ...baseInput,
      researchText: "## 1. 핵심 사실\n- 2003년 영화 마들렌",
      enforceRules: false,
      generate: async (prompt) => {
        withResearch = prompt;
        return { ok: true, output: `### TITLE\n제목\n### BODY\n${longBody}`, durationMs: 1 };
      },
    });
    assert(withResearch.includes("## 조사 자료"), "조사 기록이 프롬프트에 실려야 한다");
    assert(withResearch.includes("2003년 영화 마들렌"), "조사 기록 본문이 그대로 실려야 한다");
    assert(withResearch.includes("사실 출처는 둘뿐이다"), "조사 기록이 있으면 사실 출처가 둘이라고 못박아야 한다");

    let noResearch = "";
    await reviseArticleWithFeedback({
      ...baseInput,
      enforceRules: false,
      generate: async (prompt) => {
        noResearch = prompt;
        return { ok: true, output: `### TITLE\n제목\n### BODY\n${longBody}`, durationMs: 1 };
      },
    });
    assert(!noResearch.includes("## 조사 자료"), "조사 기록이 없으면 그 섹션이 없어야 한다");
    assert(noResearch.includes('사실 출처는 아래 "기존 원고"뿐이다'), "조사 기록이 없으면 기존 규칙 그대로여야 한다");
    console.log("✅ 조사 기록 주입 -> 사실 출처로 프롬프트에 포함(없으면 기존 문구 유지)");
  }

  // 8) 못 찾은 항목은 "쓰지 말라"고 프롬프트에 박힌다 - 지어내기 방지(인물 실명 글 원칙).
  {
    let seen = "";
    const longBody = "수정된 본문 문단입니다. ".repeat(30);
    await reviseArticleWithFeedback({
      ...baseInput,
      researchText: "## 1. 핵심 사실",
      unavailableItems: [{ item: "야수와 미녀", reason: "출처를 못 찾았다" }],
      enforceRules: false,
      generate: async (prompt) => {
        seen = prompt;
        return { ok: true, output: `### TITLE\n제목\n### BODY\n${longBody}`, durationMs: 1 };
      },
    });
    assert(seen.includes("## 절대 규칙 - 못 찾은 항목"), "못 찾은 항목 규칙 블록이 있어야 한다");
    assert(seen.includes("야수와 미녀"), "못 찾은 항목 이름이 프롬프트에 있어야 한다");
    console.log("✅ 못 찾은 항목 -> 본문에 쓰지 말라는 절대 규칙으로 전달");
  }

  // 9) 반영 불가 마커 -> blocked. **마커 누락 에러로 바뀌지 않는다**(2026-11-06 사고의 핵심).
  {
    const result = await reviseArticleWithFeedback({
      ...baseInput,
      generate: async () => ({
        ok: true,
        output: `${REVISION_BLOCKED_MARKER}\n요청한 다섯 작품이 원고에도 조사 자료에도 없습니다.`,
        durationMs: 1,
      }),
    });
    assert(result.status === "blocked", `반영 불가 마커는 blocked여야 한다 (${JSON.stringify(result)})`);
    if (result.status === "blocked") {
      assert(result.reason.includes("다섯 작품"), "모델이 적은 사유가 그대로 보존돼야 한다");
      assert(!result.reason.includes("마커 형식"), "거부 사유가 마커 누락 에러로 바뀌면 안 된다");
    }
    assert(parseBlockedReason("### TITLE\n제목\n### BODY\n본문") === null, "정상 출력에는 거부 사유가 없다");
    assert(parseBlockedReason(REVISION_BLOCKED_MARKER)?.includes("사유를 적지 않고"), "사유가 비어도 거부라는 사실은 살린다");
    console.log("✅ ### CANNOT -> blocked + 사유 보존(마커 누락 에러로 변환되지 않음)");
  }

  // 10) 반영 불가 지시문 자체가 프롬프트에 있어야 한다 - 모델에게 "못 하겠다"고 말할 자리를 준다.
  {
    let seen = "";
    const longBody = "수정된 본문 문단입니다. ".repeat(30);
    await reviseArticleWithFeedback({
      ...baseInput,
      enforceRules: false,
      generate: async (prompt) => {
        seen = prompt;
        return { ok: true, output: `### TITLE\n제목\n### BODY\n${longBody}`, durationMs: 1 };
      },
    });
    assert(seen.includes(REVISION_BLOCKED_MARKER), "프롬프트에 거부 마커 안내가 있어야 한다");
    assert(seen.includes("글의 주제를 바꾸지 않는다"), "주제 고정 지시가 있어야 한다(범위 드리프트 가드)");
    console.log("✅ 프롬프트에 거부 마커 안내 + 주제 고정 지시");
  }

  console.log("\n✅ reviseArticleWithFeedback 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
