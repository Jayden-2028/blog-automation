// 유료 API 단가표. 계측된 사용량(토큰)을 금액으로 바꾸는 유일한 지점이다.
//
// 왜 코드에 단가를 박는가: 공급자가 "이번 호출에 얼마"를 응답으로 주지 않는다. 주는 건 토큰 수뿐이고,
// 금액은 우리가 곱해야 한다. 공급자 청구액 API는 하루 단위에 수 시간 지연이라(OpenAI) 혹은 아예
// 없어서(Gemini) 실시간 대시보드의 본체가 될 수 없다 - 그쪽은 나중에 대조용으로 쓴다.
//
// **등록 원칙: 실제로 호출하는 모델만 넣는다.** 안 쓰는 모델을 미리 채워 두면 검증되지 않은 숫자가
// 오래 남아 나중에 틀린 합계를 만든다. 등록되지 않은 모델은 금액을 null로 남기고(0이 아니다)
// 대시보드가 "단가 미등록 N건"으로 드러낸다 - 조용히 과소집계되는 것보다 낫다.
//
// 출처(2026-09-16 확인, 2026-11-18 보강):
// - gpt-image-2.6-sunburst: 텍스트 입력 $5 / 이미지 입력 $8 / 이미지 출력 $30 (per 1M tokens).
//   developers.openai.com/api/docs/pricing 기준으로 gpt-image-2와 **토큰 단가는 완전히 같다.**
//   다만 **장당 비용은 같지 않다** - 같은 1536x864 / quality=low에서 출력 토큰이 120 -> 504로
//   늘어 장당 $0.0036 -> $0.0151이 된다(2026-11-18 실호출 3건 대조). 단가표는 그대로 두고
//   토큰 수가 올라가는 형태라, 이 표만 보면 교체가 공짜로 보인다 - 그래서 여기 적어 둔다.
//   같은 문서가 "캐시 입력 단가는 Responses API로 만든 이미지에만 적용된다"고 적는다. 우리는
//   /v1/images/generations를 부르므로 캐시 할인은 못 받는다 - 위 단가가 우리 단가다.
// - gpt-image-2: 같은 토큰 단가이고 **지금 호출하는 건 이쪽이다**(장당 $0.0036). 2027-02-10
//   종료라 그 전에 2.6으로 옮겨야 한다. 위 2.6 항목은 그날을 위해 **미리 등록해 둔 것**인데,
//   이 파일의 "실제로 호출하는 모델만 넣는다" 원칙에 대한 예외다 - 원칙이 막으려는 건 검증되지
//   않은 숫자이고, 저 504토큰은 2026-11-18 실호출로 직접 잰 값이다.
// - gemini-3.1-flash-lite-image: 입력 $0.25 / 이미지 출력 $30 (ai.google.dev/gemini-api/docs/pricing)
// - gemini-3.6-flash: 입력 $0.75 / 출력 $3.75, **2027-01-01부터 $1.50 / $7.50으로 인상 예정**
//   (같은 문서에 명시돼 있다). 인상일을 밴드로 넣어 두지 않으면 새해 첫날부터 실제 지출의 절반만
//   잡히는데, 그런 오차는 아무도 눈치채지 못한 채 몇 달을 간다.
// - gemini-3.1-pro-preview: 입력 $2.00 / 출력(thinking 포함) $12.00 per 1M tokens, **프롬프트 200k 토큰 이하 구간**
//   (ai.google.dev/gemini-api/docs/pricing, 2026-11-19 확인). 200k 초과는 $4 / $18이지만 인물 그림자 트랙의
//   프롬프트(조사 노트 포함)는 수만 토큰이라 닿지 않는다 - 닿으면 이 표가 과소 집계한다. Google Search
//   grounding은 월 5,000건 무료 후 1,000건당 $14인데 **토큰이 아니라 쿼리 단위라 이 표에 넣지 못한다**
//   (금액 대시보드에서 빠진다). 출력 토큰에는 thoughtsTokenCount를 더해 기록한다(runGeminiPerson.ts).

export type ApiUsageProvider = "openai" | "gemini" | "serper";

/** 한 모델의 특정 기간 단가. 전부 USD / 1M tokens. */
export type ApiPriceBand = {
  /**
   * 이 단가가 적용되는 마지막 순간(미포함, ISO 8601). 없으면 무기한.
   * 예: until "2027-01-01T00:00:00Z" = 2026-12-31까지 이 단가.
   */
  until?: string;
  inputPerMTok: number;
  /** 참조 이미지를 같이 보내는 호출(이미지 편집)의 입력 단가. 없으면 inputPerMTok과 같게 본다. */
  imageInputPerMTok?: number;
  outputPerMTok: number;
};

export type ApiModelPricing = {
  provider: ApiUsageProvider;
  /** 시간 역순이 아니라 **오래된 것부터** 넣는다(resolveBand가 위에서부터 훑는다). */
  bands: ApiPriceBand[];
  note: string;
};

export const API_PRICING: Record<string, ApiModelPricing> = {
  "gpt-image-2.6-sunburst": {
    provider: "openai",
    bands: [{ inputPerMTok: 5, imageInputPerMTok: 8, outputPerMTok: 30 }],
    note: "이미지 생성(2027-02-10 전 교체 예정). 1536x864 quality=low 실측 504토큰 ≈ $0.0151 - gpt-image-2의 4.2배라 아직 안 옮겼다.",
  },
  "gpt-image-2": {
    provider: "openai",
    bands: [{ inputPerMTok: 5, imageInputPerMTok: 8, outputPerMTok: 30 }],
    note: "이미지 생성(현역). 1536x864 quality=low 실측 120토큰 ≈ $0.0036. 2027-02-10 종료라 그 전에 2.6으로 옮겨야 한다.",
  },
  "gemini-3.1-flash-lite-image": {
    provider: "gemini",
    bands: [{ inputPerMTok: 0.25, outputPerMTok: 30 }],
    note: "이미지 생성. 이 모델의 텍스트 출력 단가는 $1.50이지만 우리는 이미지만 받으므로 $30으로 본다.",
  },
  "gemini-3.1-pro-preview": {
    provider: "gemini",
    bands: [{ inputPerMTok: 2, outputPerMTok: 12 }],
    note: "인물 제미나이 그림자 트랙(PERSON_GEMINI_SHADOW). 프롬프트 200k 이하 단가, thinking 토큰은 출력 단가. 검색 grounding $14/1,000건은 미포함.",
  },
  "gemini-3.6-flash": {
    provider: "gemini",
    bands: [
      { until: "2027-01-01T00:00:00Z", inputPerMTok: 0.75, outputPerMTok: 3.75 },
      { inputPerMTok: 1.5, outputPerMTok: 7.5 },
    ],
    note: "자료조사(RESEARCH_PROVIDER=gemini일 때만). 2027-01-01 단가 2배 인상 예정이 밴드에 반영돼 있다.",
  },
};

/**
 * 쿼리 단위로 과금되는 API의 단가(토큰 단가와 별개). 지금은 Serper뿐이다.
 *
 * Serper는 **선지불 크레딧 차감**이다(2026-10-06 50,000크레딧/$50 구매, 유효 6개월). 1,000쿼리 $1이므로
 * 쿼리당 $0.001. 10건 이하 조회는 1크레딧이라 우리 호출(num=10)은 1호출=1크레딧으로 본다 -
 * **추정이다.** 가동 1주 뒤 Serper 대시보드 Usage와 대조해 보정한다(SERPER-REVIVAL E).
 */
export const SERPER_PRICE_PER_QUERY_USD = 0.001;

export const SERPER_IMAGES_MODEL = "serper-images";
export const SERPER_SEARCH_MODEL = "serper-search";

export const API_QUERY_PRICING: Record<string, { provider: ApiUsageProvider; perQueryUsd: number; note: string }> = {
  [SERPER_IMAGES_MODEL]: {
    provider: "serper",
    perQueryUsd: SERPER_PRICE_PER_QUERY_USD,
    note: "구글 이미지 검색(/images). 1호출=1쿼리=1크레딧(추정, 1주 뒤 대조).",
  },
  [SERPER_SEARCH_MODEL]: {
    provider: "serper",
    perQueryUsd: SERPER_PRICE_PER_QUERY_USD,
    note: "구글 웹 검색(/search, 키노라이츠 작품 페이지 찾기). 1호출=1쿼리=1크레딧(추정).",
  },
};

/** 쿼리 과금 모델의 금액. 성공한 호출만 크레딧을 쓴다 - 실패(400·429)는 0으로 적는다(모름이 아니라 안 나갔다). */
export function estimateQueryCostUsd(model: string, queries: number): number | null {
  const pricing = API_QUERY_PRICING[model];
  if (!pricing) return null;
  return round6(pricing.perQueryUsd * queries);
}

function resolveBand(pricing: ApiModelPricing, occurredAt: Date): ApiPriceBand | null {
  for (const band of pricing.bands) {
    if (!band.until || occurredAt.getTime() < new Date(band.until).getTime()) return band;
  }
  return null;
}

export type EstimateCostInput = {
  model: string;
  /** 텍스트 입력 토큰. 공급자가 안 주면 null. */
  inputTokens?: number | null;
  /** 참조 이미지 입력 토큰(이미지 편집 호출). 지금 파이프라인에는 없지만 들어오면 따로 계산한다. */
  imageInputTokens?: number | null;
  outputTokens?: number | null;
  /** 단가 밴드를 고르는 기준 시각. 기본은 지금. */
  occurredAt?: Date;
};

export type EstimateCostResult = {
  /** USD. 단가나 사용량을 모르면 null - 0으로 쓰지 않는다("공짜"와 "모름"은 다르다). */
  costUsd: number | null;
  /** costUsd가 null인 이유. metadata에 그대로 남겨 대시보드가 표시한다. */
  reason?: string;
};

/** 소수점 6자리(api_usage.cost_usd가 numeric(12,6)). 이미지 1장이 $0.0036이라 이보다 굵으면 0이 된다. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function estimateCostUsd(input: EstimateCostInput): EstimateCostResult {
  const pricing = API_PRICING[input.model];
  if (!pricing) return { costUsd: null, reason: `단가 미등록 모델: ${input.model}` };

  const band = resolveBand(pricing, input.occurredAt ?? new Date());
  if (!band) return { costUsd: null, reason: `적용 가능한 단가 밴드 없음: ${input.model}` };

  const { inputTokens, imageInputTokens, outputTokens } = input;
  if (inputTokens == null && imageInputTokens == null && outputTokens == null) {
    return { costUsd: null, reason: "공급자가 usage를 주지 않았습니다." };
  }

  const imageInputRate = band.imageInputPerMTok ?? band.inputPerMTok;
  const cost =
    ((inputTokens ?? 0) * band.inputPerMTok +
      (imageInputTokens ?? 0) * imageInputRate +
      (outputTokens ?? 0) * band.outputPerMTok) /
    1_000_000;

  return { costUsd: round6(cost) };
}

/** 대시보드 각주용. 지금 어떤 모델의 단가를 알고 있는지 그대로 보여준다. */
export function listPricedModels(): Array<{ model: string; provider: ApiUsageProvider; note: string }> {
  return [
    ...Object.entries(API_PRICING).map(([model, pricing]) => ({
      model,
      provider: pricing.provider,
      note: pricing.note,
    })),
    ...Object.entries(API_QUERY_PRICING).map(([model, pricing]) => ({
      model,
      provider: pricing.provider,
      note: pricing.note,
    })),
  ];
}
