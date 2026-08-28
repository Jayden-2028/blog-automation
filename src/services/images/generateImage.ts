// AI 이미지 생성 provider 추상화(SPRINT_3_DESIGN.md 재작업, 2026-08-28 사용자 요청).
//
// 왜 provider를 나누는가: 사용자가 "ChatGPT가 만든 이미지 퀄리티를 가장 선호"하지만 "필요하면
// Gemini도 활용 가능"이라고 했다 - 기본은 OpenAI, `IMAGE_PROVIDER` 환경변수로 전환 가능하게
// 만들어 나중에 비교하거나 한쪽 API가 막혀도 다른 쪽으로 바로 돌릴 수 있게 한다.
//
// b64_json만 받는 이유: gpt-image-1은 URL 응답을 지원하지 않고 base64만 돌려준다(공식 스펙).
// 어차피 우리가 최종적으로 Supabase Storage에 직접 올릴 것이므로 바이너리를 그대로 받는 편이
// 중간 다운로드 단계를 없애 더 낫다.

export type ImageProvider = "openai" | "gemini";

export type GenerateImageInput = {
  /** 영어 생성 프롬프트. 실존 인물·브랜드 로고·실제 제품 사진을 요청하지 않아야 한다(호출자 책임). */
  prompt: string;
};

export type GenerateImageResult =
  | { ok: true; imageBuffer: Buffer; mimeType: string; provider: ImageProvider }
  | { ok: false; error: string };

const OPENAI_IMAGE_TIMEOUT_MS = 120_000;

/** gpt-image-1은 2026-10-23 종료 예정이다(모델 메타데이터 확인, 2026-08-28) - 그 전에 후속 모델로 전환해야 한다. */
const OPENAI_IMAGE_MODEL = "gpt-image-1";

async function generateWithOpenAI(input: GenerateImageInput): Promise<GenerateImageResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY가 설정되지 않았습니다." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt: input.prompt,
        size: "1024x1024",
        // 비용 통제를 위해 low로 시작한다(사용자 요청 - 실측 전 정확한 단가를 몰라 보수적으로 잡음).
        // 실측 후 품질이 부족하면 medium/high로 올리는 걸 검토한다.
        quality: "low",
        n: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return { ok: false, error: `OpenAI images API 실패: ${response.status} ${response.statusText} - ${bodyText.slice(0, 300)}` };
    }

    const json = (await response.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: "OpenAI 응답에 이미지 데이터(b64_json)가 없습니다." };

    return { ok: true, imageBuffer: Buffer.from(b64, "base64"), mimeType: "image/png", provider: "openai" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `OpenAI 이미지 생성 중 오류: ${message}` };
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
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY가 설정되지 않았습니다." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: input.prompt }] }] }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return { ok: false, error: `Gemini API 실패: ${response.status} ${response.statusText} - ${bodyText.slice(0, 300)}` };
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const b64 = part?.inlineData?.data;
    if (!b64) return { ok: false, error: "Gemini 응답에 이미지 데이터가 없습니다." };

    return {
      ok: true,
      imageBuffer: Buffer.from(b64, "base64"),
      mimeType: part?.inlineData?.mimeType ?? "image/png",
      provider: "gemini",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Gemini 이미지 생성 중 오류: ${message}` };
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
