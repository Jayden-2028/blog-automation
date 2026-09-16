// AI 이미지 생성 provider 추상화(SPRINT_3_DESIGN.md 재작업, 2026-08-28 사용자 요청).
//
// 왜 provider를 나누는가: 사용자가 "ChatGPT가 만든 이미지 퀄리티를 가장 선호"하지만 "필요하면
// Gemini도 활용 가능"이라고 했다 - 기본은 OpenAI, `IMAGE_PROVIDER` 환경변수로 전환 가능하게
// 만들어 나중에 비교하거나 한쪽 API가 막혀도 다른 쪽으로 바로 돌릴 수 있게 한다.
//
// b64_json만 받는 이유: GPT Image 계열은 URL 응답을 지원하지 않고 base64만 돌려준다(공식 스펙).
// 어차피 우리가 최종적으로 Supabase Storage에 직접 올릴 것이므로 바이너리를 그대로 받는 편이
// 중간 다운로드 단계를 없애 더 낫다.

export type ImageProvider = "openai" | "gemini";

export type GenerateImageInput = {
  /** 영어 생성 프롬프트. 실존 인물·브랜드 로고·실제 제품 사진을 요청하지 않아야 한다(호출자 책임). */
  prompt: string;
};

/**
 * 공급자가 응답에 실어 주는 사용량. 비용 계측(services/usage/recordApiUsage.ts)의 입력이다.
 * 2026-09-16 이전에는 이 값을 받아만 놓고 그대로 버렸다 - 그래서 시스템에 지출 기록이 0건이었다.
 * 공급자가 usage를 생략하면 null이고, 그 경우 금액도 null로 남는다(0으로 적지 않는다).
 */
export type GenerateImageUsage = {
  inputTokens: number | null;
  /** 참조 이미지를 같이 보낸 경우(이미지 편집). 텍스트→이미지 호출에서는 0 또는 null. */
  imageInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type GenerateImageResult =
  | {
      ok: true;
      imageBuffer: Buffer;
      mimeType: string;
      provider: ImageProvider;
      /** 실제로 호출한 모델 ID. 단가표(config/apiPricing.ts)의 키와 같다. */
      model: string;
      usage: GenerateImageUsage | null;
    }
  | { ok: false; error: string; provider: ImageProvider; model: string };

/**
 * OpenAI images API의 usage -> 공통 형태.
 *
 * input_tokens는 텍스트와 이미지 입력을 합친 값이고 둘의 단가가 다르다($5 vs $8). 그래서
 * input_tokens_details로 쪼갤 수 있으면 쪼갠다 - 지금 파이프라인은 텍스트→이미지뿐이라 이미지
 * 입력이 0이지만, 나중에 참조 이미지를 붙이면 details 없이는 조용히 과소집계된다.
 */
export function parseOpenAIUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
} | undefined): GenerateImageUsage | null {
  if (!usage) return null;

  const imageInputTokens = usage.input_tokens_details?.image_tokens ?? null;
  const textInputTokens =
    usage.input_tokens_details?.text_tokens ??
    (usage.input_tokens != null ? usage.input_tokens - (imageInputTokens ?? 0) : null);

  return {
    inputTokens: textInputTokens,
    imageInputTokens,
    outputTokens: usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

/** Gemini usageMetadata -> 공통 형태. 이 호출의 candidates 토큰은 전부 이미지다(단가 $30/1M). */
export function parseGeminiUsage(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
} | undefined): GenerateImageUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.promptTokenCount ?? null,
    imageInputTokens: null,
    outputTokens: usage.candidatesTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null,
  };
}

const OPENAI_IMAGE_TIMEOUT_MS = 120_000;

/**
 * 2026-09-16 gpt-image-1 -> gpt-image-2 교체. OpenAI 공식 deprecation 문서 기준 gpt-image-1은
 * **2026-12-01 종료**(2026-06-02 공지)이고 권장 대체 모델이 정확히 gpt-image-2다. 그 전에
 * 옮겨야 하는 데다 단가도 더 싸다(출력 $30/1M vs gpt-image-1 $40/1M, 이미지 입력 $8 vs $10).
 * `quality: "low"`는 그대로 지원된다.
 *
 * (이전 주석에 적혀 있던 "2026-10-23 종료"는 2026-08-28 모델 메타데이터에서 읽은 값인데 공식
 * 문서와 달랐다 - 문서 쪽을 따른다. docs/ai-handoff/*.md의 같은 날짜도 함께 정정했다.)
 *
 * 더 최신 계열로 gpt-image-2.5-flare / gpt-image-2.5-sunburst(2026-09-08)가 있고 단가는 2와
 * 같다(xhigh/max 화질이 추가됨). 품질·속도를 실측한 적이 없어 이번엔 안 올렸다 - 필요하면
 * A/B 비교에 한 칸 끼워 넣어 함께 본다.
 */
const OPENAI_IMAGE_MODEL = "gpt-image-2";

/**
 * 프롬프트가 지시한 비율 -> 실제 요청 크기.
 *
 * 왜 필요한가(2026-09-16 실측): 집필 규격(`prompts/writing/rules/output-format.md`)은 비율을
 * 정하고 writer도 프롬프트 끝에 `16:9 aspect ratio`를 적어 보내는데, 여기서 `size`를
 * 하드코딩해 **그 지시를 통째로 덮어쓰고 있었다** - 실제 산출물이 전부 정사각(1024x1024)이라
 * 규격이 의도한 가로형 본문 이미지가 한 번도 나온 적이 없다. 프롬프트와 API 파라미터가 서로 다른
 * 말을 하면 모델은 정사각 캔버스 안에 가로 구도를 억지로 잡는다(여백·잘림).
 *
 * **크기 기준은 구글 디스커버다**(2026-09-16 사용자 지시, developers.google.com/search/docs/
 * appearance/google-discover). 디스커버가 큰 썸네일로 띄우는 조건이 **너비 1200px 이상 + 총
 * 픽셀 30만 초과 + 16:9 가로**라, 모든 가로 비율을 너비 1200 이상으로 잡았다. 예전 기본값이던
 * 4:3(1024x768)은 "네이버 블로그 본문 가로 이미지 기준"이었는데, 2026-09-15 Blogspot 단독
 * 운영으로 전환되면서 그 근거가 사라졌다 - 이제 기본은 16:9다.
 *
 * ⚠️ 이미지 크기만으로는 부족하다. 디스커버가 큰 이미지를 쓰려면 발행되는 페이지에
 * `max-image-preview:large`(robots 메타)가 있어야 한다 - Blogger 쪽 설정이라 이 코드 밖이다.
 *
 * 비용은 오히려 내려갔다(실측, quality=low): 1024x1024 196토큰($0.0059) -> 1536x864
 * 120토큰($0.0036). 큰 쪽이 더 싼 건 정사각이 총 픽셀이 더 많기 때문이다.
 *
 * gpt-image-2는 `WIDTHxHEIGHT` 커스텀 크기를 받는다(가로·세로 모두 16의 배수, 비율 1:3~3:1,
 * 한 변 3840 이하) - 아래 값은 전부 그 제약을 지킨다.
 *
 * 세로 비율(3:4·9:16)은 디스커버 썸네일 후보가 될 수 없다(가로 요건). 본문용으로만 쓰고,
 * 그래도 너비를 최대한 키워 둔다.
 *
 * 비율 표기가 없으면 기본값 16:9로 간다. 오탐을 막으려 알려진 비율만 인식한다(프롬프트에
 * "10:00" 같은 시각이 섞여도 비율로 오인하지 않는다).
 */
const OPENAI_SIZE_BY_RATIO: Record<string, string> = {
  "16:9": "1536x864",
  "4:3": "1280x960",
  "1:1": "1280x1280",
  "3:4": "1200x1600",
  "9:16": "1152x2048",
};

const DEFAULT_OPENAI_SIZE = OPENAI_SIZE_BY_RATIO["16:9"];

export function resolveOpenAIImageSize(prompt: string): string {
  const match = prompt.match(/\b(4:3|3:4|1:1|16:9|9:16)\b/);
  return (match && OPENAI_SIZE_BY_RATIO[match[1]]) || DEFAULT_OPENAI_SIZE;
}

async function generateWithOpenAI(input: GenerateImageInput): Promise<GenerateImageResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY가 설정되지 않았습니다.", provider: "openai", model: OPENAI_IMAGE_MODEL };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt: input.prompt,
        size: resolveOpenAIImageSize(input.prompt),
        // 비용 통제를 위해 low로 시작한다(사용자 요청 - 실측 전 정확한 단가를 몰라 보수적으로 잡음).
        // 실측 후 품질이 부족하면 medium/high로 올리는 걸 검토한다.
        quality: "low",
        n: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return {
        ok: false,
        error: `OpenAI images API 실패: ${response.status} ${response.statusText} - ${bodyText.slice(0, 300)}`,
        provider: "openai",
        model: OPENAI_IMAGE_MODEL,
      };
    }

    const json = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { text_tokens?: number; image_tokens?: number };
      };
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: "OpenAI 응답에 이미지 데이터(b64_json)가 없습니다.", provider: "openai", model: OPENAI_IMAGE_MODEL };

    return {
      ok: true,
      imageBuffer: Buffer.from(b64, "base64"),
      mimeType: "image/png",
      provider: "openai",
      model: OPENAI_IMAGE_MODEL,
      usage: parseOpenAIUsage(json.usage),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `OpenAI 이미지 생성 중 오류: ${message}`, provider: "openai", model: OPENAI_IMAGE_MODEL };
  } finally {
    clearTimeout(timer);
  }
}

const GEMINI_IMAGE_TIMEOUT_MS = 120_000;
// Gemini 이미지 생성 모델(사용자 결정, 2026-08-28: "나노바나나2 라이트"). /v1beta/models 목록에서
// displayName으로 정확한 모델 ID를 확인했다 - "Nano Banana"는 gemini-2.5-flash-image,
// "Nano Banana Pro"는 gemini-3-pro-image, "Nano Banana 2"는 gemini-3.1-flash-image이고
// "Nano Banana 2 Lite"가 gemini-3.1-flash-lite-image다.
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";

async function generateWithGemini(input: GenerateImageInput): Promise<GenerateImageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY가 설정되지 않았습니다.", provider: "gemini", model: GEMINI_IMAGE_MODEL };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ⚠️ 알려진 한계(2026-09-16): 크기·비율 파라미터를 전혀 안 보낸다. 그래서 산출 치수가
        // 모델 재량으로 정해져 실측에서 1200x896(4:3)과 1408x768(16:9)이 섞여 나왔다 - OpenAI와
        // 달리 비율이 통제되지 않는다. 지금은 IMAGE_PROVIDER=openai로 고정해 이 경로를 안 쓰기로
        // 해서(2026-09-16 사용자 결정) 그대로 두지만, Gemini를 다시 쓰게 되면
        // generationConfig의 imageConfig(aspectRatio)로 맞춰야 한다.
        body: JSON.stringify({ contents: [{ parts: [{ text: input.prompt }] }] }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return {
        ok: false,
        error: `Gemini API 실패: ${response.status} ${response.statusText} - ${bodyText.slice(0, 300)}`,
        provider: "gemini",
        model: GEMINI_IMAGE_MODEL,
      };
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const b64 = part?.inlineData?.data;
    if (!b64) return { ok: false, error: "Gemini 응답에 이미지 데이터가 없습니다.", provider: "gemini", model: GEMINI_IMAGE_MODEL };

    return {
      ok: true,
      imageBuffer: Buffer.from(b64, "base64"),
      mimeType: part?.inlineData?.mimeType ?? "image/png",
      provider: "gemini",
      model: GEMINI_IMAGE_MODEL,
      usage: parseGeminiUsage(json.usageMetadata),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Gemini 이미지 생성 중 오류: ${message}`, provider: "gemini", model: GEMINI_IMAGE_MODEL };
  } finally {
    clearTimeout(timer);
  }
}

/** IMAGE_PROVIDER 환경변수로 고른다. 기본은 openai(사용자가 가장 선호한다고 밝힌 품질). */
export function resolveImageProvider(): ImageProvider {
  const value = process.env.IMAGE_PROVIDER?.toLowerCase();
  return value === "gemini" ? "gemini" : "openai";
}

export async function generateImage(
  input: GenerateImageInput,
  provider: ImageProvider = resolveImageProvider()
): Promise<GenerateImageResult> {
  return provider === "gemini" ? generateWithGemini(input) : generateWithOpenAI(input);
}
