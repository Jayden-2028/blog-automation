// Gemini(Google Search grounding)로 자료조사 프롬프트 1회를 실행하는 얇은 래퍼.
//
// runHeadlessClaude.ts와 짝을 이루지만 구조가 다르다: Gemini에는 Read/Write 도구가 없으므로
// 여기서는 순수하게 REST API만 부른다 - "regulator.md를 읽고 파일에 써라" 대신, 호출자
// (buildGeminiResearchPrompt)가 규격 전문을 프롬프트에 인라인하고, 응답 텍스트를 호출자가
// 직접 파일에 쓴다.
//
// SDK(@google/genai) 대신 fetch를 직접 쓰는 이유: 이 프로젝트의 의존성은 supabase-js/dotenv/
// node-html-parser/playwright뿐이다(package.json). generateContent 엔드포인트 하나만 부르는데
// SDK 전체를 추가할 이유가 없고, Node 22는 전역 fetch/AbortController를 이미 제공한다.
//
// 근거 신뢰성: tools에 google_search를 켜면 모델이 실제 검색 결과에 grounding한 답만 낸다
// (Claude의 WebSearch와 동급 보장). candidate.groundingMetadata.groundingChunks에 실제로
// 인용된 URL이 구조화된 형태로 딸려온다 - 모델이 URL을 잘못 타이핑해도 이 목록으로 교차 확인할
// 수 있다(현재는 참고용으로만 반환, 강제 검증은 하지 않는다).

import { GEMINI_RESEARCH_MODEL } from "../../config/researchProvider.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** researcher 에이전트는 여러 번 검색하고 근거를 종합한다 - 넉넉히 잡되 job을 막지 않을 만큼. */
export const DEFAULT_GEMINI_TIMEOUT_MS = 5 * 60 * 1000;

export type RunGeminiResearchOptions = {
  prompt: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type GeminiGroundingSource = { title: string | null; url: string };

/**
 * 응답에 실려 오는 사용량. 비용 계측(services/usage/recordApiUsage.ts)의 입력이다.
 * 공급자가 생략하면 null이고, 그 경우 금액도 null로 남는다(0으로 적지 않는다).
 */
export type GeminiResearchUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type RunGeminiResearchResult =
  | {
      ok: true;
      text: string;
      groundingSources: GeminiGroundingSource[];
      durationMs: number;
      /** 실제로 호출한 모델 ID. 단가표(config/apiPricing.ts)의 키와 같다. */
      model: string;
      usage: GeminiResearchUsage | null;
    }
  | { ok: false; error: string; durationMs: number };

type GeminiGenerateContentResponse = {
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
};

export async function runGeminiResearch(
  options: RunGeminiResearchOptions
): Promise<RunGeminiResearchResult> {
  const startedAt = Date.now();
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY가 설정돼 있지 않습니다.", durationMs: Date.now() - startedAt };
  }

  const model = options.model ?? GEMINI_RESEARCH_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 16000 },
      }),
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return {
        ok: false,
        error: `Gemini API가 ${response.status}로 응답했습니다${bodyText ? ` - ${bodyText.slice(0, 500)}` : ""}`,
        durationMs,
      };
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();

    if (!text) {
      const reason = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : "";
      return { ok: false, error: `Gemini가 빈 응답을 반환했습니다${reason}`, durationMs };
    }

    const groundingSources: GeminiGroundingSource[] = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((chunk) => chunk.web)
      .filter((web): web is { uri: string; title?: string } => Boolean(web?.uri))
      .map((web) => ({ title: web.title ?? null, url: web.uri }));

    const usage: GeminiResearchUsage | null = data.usageMetadata
      ? {
          inputTokens: data.usageMetadata.promptTokenCount ?? null,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? null,
          totalTokens: data.usageMetadata.totalTokenCount ?? null,
        }
      : null;

    return { ok: true, text, groundingSources, durationMs, model, usage };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Gemini 호출이 ${timeoutMs}ms 안에 끝나지 않아 중단했습니다.`, durationMs };
    }
    return {
      ok: false,
      error: `Gemini 호출 실패: ${error instanceof Error ? error.message : String(error)}`,
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
