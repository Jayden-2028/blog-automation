// 유료 API 호출 1건을 비용 원장에 남긴다. 단가표(config/apiPricing.ts)와 원장
// (repositories/ApiUsageRepository.ts)을 이어 붙이는 얇은 층이다.
//
// 호출자 계약: **await 하되 실패를 신경 쓰지 않아도 된다.** 던지지 않고, 실패하면 경고만 찍는다.
// 파이프라인이 이미 돈을 쓴 뒤에 관측 실패로 산출물을 잃는 일은 없어야 한다.
//
// 어디서 부르나: 유료 호출을 한 **직후, 그 호출을 감싼 워크플로에서** 부른다. 호출 함수
// (generateImage 등) 안에서 직접 부르지 않는 이유는 그 함수를 DB에 묶지 않기 위해서다 -
// 지금은 순수하게 fetch만 해서 테스트에서 Supabase 없이 돌릴 수 있다.

import { estimateCostUsd } from "../../config/apiPricing.js";
import type { ApiUsageProvider } from "../../config/apiPricing.js";
import { ApiUsageRepository } from "../../repositories/ApiUsageRepository.js";

/** 공급자 응답에서 뽑아낸 사용량. 공급자가 안 주면 필드가 없거나 null이다. */
export type ApiUsageTokens = {
  inputTokens?: number | null;
  /** 참조 이미지를 같이 보낸 호출의 입력 토큰(단가가 텍스트 입력과 다르다). */
  imageInputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

export type RecordApiUsageInput = {
  provider: ApiUsageProvider;
  /** 실제 호출한 모델 ID. 단가표의 키와 같아야 금액이 나온다. */
  model: string;
  /** <도메인>.<동작> 형식. "image.generate" | "research.generate". */
  operation: string;
  usage?: ApiUsageTokens | null;
  /** 어느 원고 때문에 나간 비용인지. 원고 1건당 단가를 내려면 필요하다. */
  jobId?: string | null;
  /** 이미지 장수 등. 금액 계산에는 쓰지 않는다(참고용). */
  quantity?: number;
  metadata?: Record<string, unknown>;
};

export async function recordApiUsage(input: RecordApiUsageInput): Promise<void> {
  const occurredAt = new Date();
  const usage = input.usage ?? {};

  const { costUsd, reason } = estimateCostUsd({
    model: input.model,
    inputTokens: usage.inputTokens,
    imageInputTokens: usage.imageInputTokens,
    outputTokens: usage.outputTokens,
    occurredAt,
  });

  const result = await ApiUsageRepository.record({
    occurred_at: occurredAt.toISOString(),
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    total_tokens: usage.totalTokens ?? null,
    quantity: input.quantity ?? 1,
    cost_usd: costUsd,
    cost_source: "metered",
    job_id: input.jobId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      ...(usage.imageInputTokens != null ? { imageInputTokens: usage.imageInputTokens } : {}),
      // 금액이 null인 이유를 행 안에 남긴다 - 나중에 "왜 이 호출만 비용이 비었지"를 되짚을 수 있다.
      ...(reason ? { costUnknownReason: reason } : {}),
    },
  });

  if (!result.ok) {
    console.warn(`⚠️ 비용 기록 실패(무시하고 계속): ${input.provider}/${input.model} - ${result.error}`);
  }
}
