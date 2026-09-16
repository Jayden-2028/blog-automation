// 단가표 회귀 테스트. 외부 호출 없음(순수 함수만 검증).
//
// 이 계산이 틀리면 대시보드가 조용히 거짓말을 한다 - 아무도 즉시 눈치채지 못하는 종류의 버그라
// 경계 조건(단가 미등록 / usage 누락 / 단가 인상일)을 특히 촘촘히 고정한다.
import { estimateCostUsd } from "./apiPricing.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ apiPricing 테스트 시작\n");

  // 1) 실측 기준점: gpt-image-2 / 1536x864 / quality=low = 출력 120토큰 ≈ $0.0036
  //    (docs/ai-handoff/CURRENT_STATE.md 2026-09-16 실측값과 같은 자리에서 맞아야 한다).
  const image = estimateCostUsd({ model: "gpt-image-2", inputTokens: 0, outputTokens: 120 });
  assert(image.costUsd === 0.0036, `이미지 1장 $0.0036이어야 한다 (실제: ${image.costUsd})`);
  console.log("✅ gpt-image-2 출력 120토큰 = $0.0036 (실측과 일치)");

  // 2) 텍스트 입력과 이미지 입력은 단가가 다르다($5 vs $8). 합쳐서 계산하면 틀린다.
  const mixed = estimateCostUsd({
    model: "gpt-image-2",
    inputTokens: 1_000_000,
    imageInputTokens: 1_000_000,
    outputTokens: 0,
  });
  assert(mixed.costUsd === 13, `텍스트 $5 + 이미지 $8 = $13이어야 한다 (실제: ${mixed.costUsd})`);
  console.log("✅ 텍스트 입력 / 이미지 입력 단가 분리");

  // 3) 단가 미등록 모델은 **0이 아니라 null**이다. 0으로 적으면 "공짜로 썼다"가 되어 합계가
  //    조용히 과소집계되고, 그 오차는 청구서를 받기 전까지 드러나지 않는다.
  const unknown = estimateCostUsd({ model: "gpt-image-9-미래모델", outputTokens: 500 });
  assert(unknown.costUsd === null, "단가 미등록 모델은 null이어야 한다");
  assert(unknown.reason?.includes("단가 미등록"), "사유가 남아야 한다");
  console.log("✅ 단가 미등록 모델 -> null + 사유");

  // 4) 공급자가 usage를 아예 안 주면 역시 null이다.
  const noUsage = estimateCostUsd({ model: "gpt-image-2" });
  assert(noUsage.costUsd === null, "usage가 없으면 null이어야 한다");
  console.log("✅ usage 누락 -> null");

  // 5) 단가 인상일(2027-01-01) 경계. 이게 깨지면 새해부터 실제 지출의 절반만 잡히는데,
  //    그런 오차는 몇 달씩 눈에 띄지 않는다.
  const before = estimateCostUsd({
    model: "gemini-3.6-flash",
    inputTokens: 1_000_000,
    outputTokens: 0,
    occurredAt: new Date("2026-12-31T23:59:00Z"),
  });
  const after = estimateCostUsd({
    model: "gemini-3.6-flash",
    inputTokens: 1_000_000,
    outputTokens: 0,
    occurredAt: new Date("2027-01-01T00:00:00Z"),
  });
  assert(before.costUsd === 0.75, `인상 전 $0.75여야 한다 (실제: ${before.costUsd})`);
  assert(after.costUsd === 1.5, `인상 후 $1.50여야 한다 (실제: ${after.costUsd})`);
  console.log("✅ gemini-3.6-flash 2027-01-01 단가 인상 밴드");

  // 6) Gemini 이미지: 출력 1120토큰 = $0.0336(공식 문서의 "1K 이미지당" 예시와 같아야 한다).
  const geminiImage = estimateCostUsd({
    model: "gemini-3.1-flash-lite-image",
    inputTokens: 0,
    outputTokens: 1120,
  });
  assert(geminiImage.costUsd === 0.0336, `Gemini 이미지 1장 $0.0336이어야 한다 (실제: ${geminiImage.costUsd})`);
  console.log("✅ gemini-3.1-flash-lite-image 1120토큰 = $0.0336 (공식 문서와 일치)");

  // 7) 소수점 6자리까지 살아 있어야 한다 - 이미지 1장이 $0.0036이라 4자리에서 자르면 0이 된다.
  const tiny = estimateCostUsd({ model: "gpt-image-2", outputTokens: 1 });
  assert(tiny.costUsd === 0.00003, `1토큰 $0.00003이어야 한다 (실제: ${tiny.costUsd})`);
  console.log("✅ 소수점 6자리 보존");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
