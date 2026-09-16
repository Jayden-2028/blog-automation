// resolveOpenAIImageSize 회귀 테스트. 외부 API 호출 없음(순수 함수만 검증).
//
// 왜 이 테스트가 있는가(2026-09-16): 집필 규격은 비율을 정해 프롬프트 끝에 적어 보내는데,
// 호출부가 size를 1024x1024로 하드코딩해 그 지시를 덮어쓰고 있었다(전 산출물이 정사각).
// 되돌아가지 않도록 매핑을 고정한다.
//
// 크기 기준은 **구글 디스커버**다(사용자 지시): 큰 썸네일 조건이 "너비 1200px 이상 + 총 픽셀
// 30만 초과 + 16:9 가로"라, 가로 비율은 전부 이 선을 넘겨야 한다.
import { parseGeminiUsage, parseOpenAIUsage, resolveOpenAIImageSize } from "./generateImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const dim = (size: string): [number, number] => size.split("x").map(Number) as [number, number];

async function main(): Promise<void> {
  console.log("▶ resolveOpenAIImageSize 테스트 시작\n");

  // 1) 기본값 16:9 -> 1536x864(둘 다 16의 배수, 너비 1536 >= 1200).
  const real =
    "A simple flat illustration of a single paper coffee cup with steam rising, placed on a plain counter, " +
    "warm orange and brown color palette, minimal blurred background, no people, no text, no letters, " +
    "soft morning lighting, clean modern illustration style. 16:9 aspect ratio.";
  assert(resolveOpenAIImageSize(real) === "1536x864", `16:9 -> 1536x864 (실제: ${resolveOpenAIImageSize(real)})`);
  console.log("✅ 16:9 -> 1536x864 (디스커버 대표 이미지 규격)");

  // 2) 나머지 비율도 규격대로 매핑된다.
  assert(resolveOpenAIImageSize("... 4:3 aspect ratio.") === "1280x960", "4:3 -> 1280x960");
  assert(resolveOpenAIImageSize("... 1:1 aspect ratio.") === "1280x1280", "1:1 -> 1280x1280");
  assert(resolveOpenAIImageSize("... 3:4 aspect ratio.") === "1200x1600", "3:4 -> 1200x1600");
  assert(resolveOpenAIImageSize("... 9:16 aspect ratio.") === "1152x2048", "9:16 -> 1152x2048");
  console.log("✅ 4:3 / 1:1 / 3:4 / 9:16 매핑");

  // 3) 비율 표기가 없으면 기본값 16:9 - 정사각으로 되돌아가면 안 된다.
  assert(resolveOpenAIImageSize("A flat illustration with no ratio mentioned.") === "1536x864", "표기 없음 -> 16:9 기본");
  console.log("✅ 비율 표기 없음 -> 기본 16:9");

  // 4) 비율이 아닌 숫자쌍(시각 등)을 비율로 오인하면 안 된다.
  const withTime = "A shop notice showing business hours 10:00 - 17:00, no text, no letters.";
  assert(resolveOpenAIImageSize(withTime) === "1536x864", `시각 표기를 비율로 오인하면 안 된다 (${resolveOpenAIImageSize(withTime)})`);
  console.log("✅ '10:00' 같은 시각은 비율로 오인하지 않음");

  // 5) gpt-image-2 커스텀 크기 제약: 가로·세로 모두 16의 배수, 한 변 3840 이하, 비율 1:3~3:1.
  for (const ratio of ["16:9", "4:3", "1:1", "3:4", "9:16"]) {
    const [w, h] = dim(resolveOpenAIImageSize(`x ${ratio} aspect ratio`));
    assert(w % 16 === 0 && h % 16 === 0, `${ratio} -> ${w}x${h}는 16의 배수여야 한다`);
    assert(w <= 3840 && h <= 3840, `${ratio} -> 한 변이 3840을 넘으면 안 된다`);
    const long = Math.max(w, h) / Math.min(w, h);
    assert(long <= 3, `${ratio} -> 비율이 1:3~3:1을 벗어나면 안 된다 (${long.toFixed(2)})`);
  }
  console.log("✅ 모든 크기가 gpt-image-2 제약(16의 배수 / 3840 이하 / 1:3~3:1) 충족");

  // 6) 디스커버 요건: 가로 비율은 너비 1200px 이상 + 총 픽셀 30만 초과여야 큰 썸네일을 받는다.
  for (const ratio of ["16:9", "4:3"]) {
    const [w, h] = dim(resolveOpenAIImageSize(`x ${ratio} aspect ratio`));
    assert(w >= 1200, `${ratio} -> 너비 ${w}는 디스커버 최소 1200px 미만이면 안 된다`);
    assert(w * h > 300_000, `${ratio} -> 총 픽셀 ${w * h}는 30만을 넘어야 한다`);
  }
  console.log("✅ 가로 비율은 디스커버 요건(너비 1200+ / 픽셀 30만+) 충족");

  // 7) 세로·정사각도 총 픽셀 요건은 넘겨 둔다(디스커버 썸네일 후보는 아니지만 본문 품질 기준).
  for (const ratio of ["1:1", "3:4", "9:16"]) {
    const [w, h] = dim(resolveOpenAIImageSize(`x ${ratio} aspect ratio`));
    assert(w * h > 300_000, `${ratio} -> 총 픽셀 ${w * h}는 30만을 넘어야 한다`);
  }
  console.log("✅ 세로·정사각도 총 픽셀 30만 초과");

  // 8) usage 파싱(2026-09-16 비용 계측). 이 값을 버리고 있었던 탓에 시스템에 지출 기록이 0건이었다.
  const openai = parseOpenAIUsage({
    input_tokens: 30,
    output_tokens: 120,
    total_tokens: 150,
    input_tokens_details: { text_tokens: 30, image_tokens: 0 },
  });
  assert(openai?.inputTokens === 30 && openai?.outputTokens === 120, "OpenAI usage를 그대로 읽어야 한다");
  assert(openai?.imageInputTokens === 0, "참조 이미지가 없으면 image_tokens는 0이다");
  console.log("✅ OpenAI usage 파싱");

  // details가 없으면 input_tokens 전체를 텍스트로 본다(텍스트→이미지 호출에서는 그게 맞다).
  const noDetails = parseOpenAIUsage({ input_tokens: 42, output_tokens: 120 });
  assert(noDetails?.inputTokens === 42 && noDetails?.imageInputTokens === null, "details 없으면 전부 텍스트 입력");

  // 참조 이미지를 같이 보낸 호출은 단가가 다르므로($5 vs $8) 반드시 쪼개져야 한다.
  const withImageInput = parseOpenAIUsage({
    input_tokens: 1150,
    output_tokens: 120,
    input_tokens_details: { text_tokens: 30, image_tokens: 1120 },
  });
  assert(withImageInput?.inputTokens === 30, "텍스트 입력만 inputTokens에 들어가야 한다");
  assert(withImageInput?.imageInputTokens === 1120, "이미지 입력은 따로 잡혀야 한다(단가가 다르다)");
  console.log("✅ 이미지 입력 토큰 분리");

  // 공급자가 usage를 생략하면 null이다 - 0으로 만들면 "공짜"로 오해된다.
  assert(parseOpenAIUsage(undefined) === null, "usage 없으면 null");
  assert(parseGeminiUsage(undefined) === null, "usageMetadata 없으면 null");

  const gemini = parseGeminiUsage({ promptTokenCount: 15, candidatesTokenCount: 1120, totalTokenCount: 1135 });
  assert(gemini?.inputTokens === 15 && gemini?.outputTokens === 1120, "Gemini usageMetadata 파싱");
  console.log("✅ Gemini usage 파싱 / usage 누락 시 null");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
