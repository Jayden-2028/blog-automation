// reviseArticleWithFeedback 테스트. generate를 주입해 실제 claude -p 호출 없이 파싱·검증 로직만
// 확인한다(generateArticleVariant.ts의 테스트 부재와 달리, 이 모듈은 마커 파싱이 핵심이라 여기서는
// 순수 로직을 검증해둔다).

import { parseRevisionOutput, reviseArticleWithFeedback } from "./reviseArticleWithFeedback.js";

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

  console.log("\n✅ reviseArticleWithFeedback 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
