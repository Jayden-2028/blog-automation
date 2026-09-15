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

export type GenerateImageResult =
  | { ok: true; imageBuffer: Buffer; mimeType: string; provider: ImageProvider }
  | { ok: false; error: string };

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
 * 왜 필요한가(2026-09-16 실측): 집필 규격(`prompts/writing/rules/output-format.md`
 * "AI 생성 프롬프트 규칙")은 "비율은 4:3을 기본으로 한다. 네이버 블로그 본문 가로 이미지
 * 기준이다. 세로 컷이 필요하면 3:4, 표·카드뉴스형은 1:1"이라고 정하고, writer도 프롬프트 끝에
 * `4:3 aspect ratio`를 제대로 적어 보낸다. 그런데 여기서 `size: "1024x1024"`를 하드코딩해
 * **그 지시를 통째로 덮어쓰고 있었다** - 실제 산출물이 전부 정사각(1024x1024)이라 규격이 의도한
 * 가로형 본문 이미지가 한 번도 나온 적이 없다. 프롬프트와 API 파라미터가 서로 다른 말을 하면
 * 모델은 정사각 캔버스 안에 4:3 구도를 억지로 잡는다(여백·잘림).
 *
 * gpt-image-2는 `WIDTHxHEIGHT` 커스텀 크기를 받는다(가로·세로 모두 16의 배수, 비율 1:3~3:1,
 * 한 변 3840 이하). 그래서 4:3은 1024x768(768 = 48*16)로 정확히 맞출 수 있다.
 *
 * 비율 표기가 없으면 규격의 기본값인 4:3으로 간다. 오탐을 막으려 알려진 비율만 인식한다
 * (프롬프트에 "10:00" 같은 시각이 섞여도 비율로 오인하지 않는다).
 */
const OPENAI_SIZE_BY_RATIO: Record<string, string> = {
  "4:3": "1024x768",
  "3:4": "768x1024",
  "1:1": "1024x1024",
  "16:9": "1024x576",
  "9:16": "576x1024",
};

const DEFAULT_OPENAI_SIZE = OPENAI_SIZE_BY_RATIO["4:3"];

export function resolveOpenAIImageSize(prompt: string): string {
  const match = prompt.match(/\b(4:3|3:4|1:1|16:9|9:16)\b/);
  return (match && OPENAI_SIZE_BY_RATIO[match[1]]) || DEFAULT_OPENAI_SIZE;
}

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
