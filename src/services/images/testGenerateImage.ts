// resolveOpenAIImageSize 회귀 테스트. 외부 API 호출 없음(순수 함수만 검증).
//
// 왜 이 테스트가 있는가(2026-09-16): 집필 규격은 "비율 4:3 기본"이고 writer도 프롬프트 끝에
// `4:3 aspect ratio`를 적어 보내는데, 호출부가 size를 1024x1024로 하드코딩해 그 지시를 덮어쓰고
// 있었다(전 산출물이 정사각). 되돌아가지 않도록 매핑을 고정한다.
import { resolveOpenAIImageSize } from "./generateImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ resolveOpenAIImageSize 테스트 시작\n");

  // 1) 규격 기본값 4:3 -> 정확히 4:3인 1024x768(768 = 48*16, gpt-image-2의 "16의 배수" 제약 충족).
  const real =
    "A simple flat illustration of a single paper coffee cup with steam rising, placed on a plain counter, " +
    "warm orange and brown color palette, minimal blurred background, no people, no text, no letters, " +
    "soft morning lighting, clean modern illustration style. 4:3 aspect ratio.";
  assert(resolveOpenAIImageSize(real) === "1024x768", `4:3 -> 1024x768 (실제: ${resolveOpenAIImageSize(real)})`);
  console.log("✅ 4:3 -> 1024x768 (가로형 본문 이미지)");

  // 2) 세로 컷과 카드뉴스형도 규격대로 매핑된다.
  assert(resolveOpenAIImageSize("... 3:4 aspect ratio.") === "768x1024", "3:4 -> 768x1024");
  assert(resolveOpenAIImageSize("... 1:1 aspect ratio.") === "1024x1024", "1:1 -> 1024x1024");
  console.log("✅ 3:4 -> 768x1024 / 1:1 -> 1024x1024");

  // 3) 규격엔 없지만 들어오면 존중한다(와이드 컷).
  assert(resolveOpenAIImageSize("... 16:9 aspect ratio.") === "1024x576", "16:9 -> 1024x576");
  assert(resolveOpenAIImageSize("... 9:16 aspect ratio.") === "576x1024", "9:16 -> 576x1024");
  console.log("✅ 16:9 / 9:16도 존중");

  // 4) 비율 표기가 없으면 규격 기본값(4:3)으로 간다 - 정사각으로 되돌아가면 안 된다.
  assert(resolveOpenAIImageSize("A flat illustration with no ratio mentioned.") === "1024x768", "표기 없음 -> 4:3 기본");
  console.log("✅ 비율 표기 없음 -> 기본 4:3");

  // 5) 비율이 아닌 숫자쌍(시각 등)을 비율로 오인하면 안 된다.
  const withTime = "A shop notice showing business hours 10:00 - 17:00, no text, no letters.";
  assert(resolveOpenAIImageSize(withTime) === "1024x768", `시각 표기를 비율로 오인하면 안 된다 (${resolveOpenAIImageSize(withTime)})`);
  console.log("✅ '10:00' 같은 시각은 비율로 오인하지 않음");

  // 6) 모든 매핑이 gpt-image-2 제약(가로·세로 16의 배수)을 지키는지.
  for (const ratio of ["4:3", "3:4", "1:1", "16:9", "9:16"]) {
    const [w, h] = resolveOpenAIImageSize(`x ${ratio} aspect ratio`).split("x").map(Number);
    assert(w % 16 === 0 && h % 16 === 0, `${ratio} -> ${w}x${h}는 16의 배수여야 한다`);
  }
  console.log("✅ 모든 크기가 16의 배수(gpt-image-2 커스텀 크기 제약)");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
