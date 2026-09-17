// 웹 검색 실패 -> AI 생성 폴백 테스트. Claude 호출을 주입해 외부 호출 없이 파싱·검증·합류만 본다.
//
// 지켜야 할 불변식 둘:
//   1. **자리 번호가 보존된다.** 폴백으로 만든 이미지가 원래 마커 번호에 그대로 붙어야 한다 -
//      밀리면 엉뚱한 문단에 이미지가 달린다(뷰어가 index로 짝짓는다).
//   2. **규격 위반 프롬프트는 버린다.** 한글이 섞이거나 `no text`·비율이 없으면 생성하지 않는다.

import { buildFallbackPrompt, buildFallbackImagePrompts, parseFallbackPrompts } from "./buildFallbackImagePrompts.js";
import { generateManuscriptImages } from "./generateManuscriptImages.js";
import type { UnfilledSlot } from "./collectWebImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const UNFILLED: UnfilledSlot[] = [
  {
    index: 1,
    description: "간돌검 분장을 한 이혜정의 결선 진출 모습 — 웹 검색",
    context: "이혜정 씨는 간돌검 분장으로 결선에 올랐습니다.",
    suggestion: "실존 인물이라 찾지 못했다. 유물 분장을 한 참가자의 일반적 장면을 AI로 만드는 편이 낫다.",
  },
  {
    index: 5,
    description: "안동 탈놀이단이 결선 오프닝 무대에서 공연하는 모습 — 웹 검색",
    context: "결선 오프닝은 안동 탈놀이단이 엽니다.",
    suggestion: "공연은 9월 19일 예정이라 아직 사진이 존재하지 않는다.",
  },
];

// --- 1. 프롬프트에 실패 사유와 문단이 실린다 -------------------------------------------------
{
  const prompt = buildFallbackPrompt("국중박 분장놀이", UNFILLED);
  assert(prompt.includes("### 자리 1") && prompt.includes("### 자리 5"), "자리 번호가 프롬프트에 없습니다");
  assert(prompt.includes("9월 19일 예정"), "수집기의 실패 사유가 전달되지 않습니다");
  assert(prompt.includes("이혜정 씨는 간돌검"), "문단 원문이 전달되지 않습니다");
  assert(prompt.includes("no text, no letters"), "프롬프트 규격이 지시되지 않습니다");
  console.log("✅ 폴백 프롬프트에 실패 사유·문단·규격이 실린다");
}

// --- 2. 출력 파싱: 잡음과 여러 줄 프롬프트를 견딘다 ------------------------------------------
{
  const parsed = parseFallbackPrompts(
    [
      "알겠습니다. 아래에 정리했습니다.",
      "",
      "INDEX: 1",
      "PROMPT: A photorealistic photograph of a person in Korea wearing a museum artifact costume,",
      "standing on a stage, documentary style, no text, no letters. 16:9.",
      "",
      "INDEX: 5",
      "PROMPT: A photorealistic photograph of Korean traditional mask dancers performing outdoors, no text, no letters. 16:9.",
    ].join("\n")
  );
  assert(parsed.length === 2, `2개를 기대했는데 ${parsed.length}개입니다`);
  assert(parsed[0].index === 1 && parsed[1].index === 5, "자리 번호가 잘못 파싱됐습니다");
  assert(parsed[0].prompt.includes("standing on a stage"), "여러 줄 프롬프트가 이어지지 않았습니다");
  assert(!parsed[0].prompt.includes("\n"), "프롬프트에 줄바꿈이 남았습니다");
  console.log("✅ 잡음·여러 줄 출력을 파싱한다");
}

// --- 3. 규격 위반 프롬프트는 버린다 -----------------------------------------------------------
{
  const result = await buildFallbackImagePrompts(
    { keyword: "국중박 분장놀이", unfilled: UNFILLED },
    {
      generate: async () => ({
        ok: true as const,
        // 자리 1은 한글이 섞였고, 자리 5는 정상이다.
        output: [
          "INDEX: 1",
          "PROMPT: A photorealistic photograph of 간돌검 costume, no text, no letters. 16:9.",
          "",
          "INDEX: 5",
          "PROMPT: A photorealistic photograph of Korean mask dancers outdoors, no text, no letters. 16:9.",
        ].join("\n"),
        durationMs: 1,
      }),
    }
  );
  assert(result.slots.length === 1, `1개만 통과해야 하는데 ${result.slots.length}개입니다`);
  assert(result.slots[0].index === 5, "통과한 자리 번호가 틀렸습니다");
  assert(result.failures.some((f) => f.includes("자리 1")), "자리 1의 탈락이 기록되지 않았습니다");
  console.log("✅ 한글이 섞인 폴백 프롬프트를 버린다");
}

// --- 3-1. 실물 특정 자리는 모델이 SKIP하면 비워 둔다(2026-09-17 저녁, 사용자 반려 대응) -------------
{
  const result = await buildFallbackImagePrompts(
    { keyword: "인턴", unfilled: UNFILLED },
    {
      generate: async () => ({
        ok: true as const,
        output: [
          "INDEX: 1",
          "SKIP: 실존 인물 이혜정의 실제 모습이 필요한 자리",
          "",
          "INDEX: 5",
          "PROMPT: A photorealistic photograph of Korean mask dancers outdoors, no text, no letters. 16:9.",
        ].join("\n"),
        durationMs: 1,
      }),
    }
  );
  assert(result.slots.length === 1 && result.slots[0].index === 5, "SKIP한 자리가 생성 목록에 들어갔습니다");
  assert(result.failures.some((f) => f.includes("자리 1") && f.includes("실물 특정")), "SKIP 사유가 기록되지 않았습니다");
  assert(result.slots[0].description.includes("AI 대체 장면"), "대체 이미지 표시가 설명에 없습니다");
  console.log("✅ 실물 특정 자리는 SKIP - 비워 두고 사유 기록, 대체 자리는 캡션에 표시");
}

// --- 4. 폴백 자리가 원래 번호 그대로 생성된다 -------------------------------------------------
{
  const body = [
    "첫 문단입니다.",
    "[IMAGE: 웹에서 찾아야 하는 사진 — 웹 검색]",
    "둘째 문단입니다.",
    "[IMAGE: 일반적인 장면 — AI 생성]",
  ].join("\n\n");

  const result = await generateManuscriptImages(
    { jobId: "job-1", keyword: "테스트", date: "2026-09-17", body, imagePrompts: ["검색어", "An illustration, no text. 16:9."] },
    {
      config: { enabled: true, abCompare: false, maxPerArticle: 10 } as never,
      // 폴백만 생성한다 - 이미 끝난 AI 자리를 다시 만들지 않는다.
      onlyIndexes: [],
      fallbackSlots: [{ index: 1, description: "웹에서 찾아야 하는 사진", prompt: "A photo, no text. 16:9." }],
      generate: async () => ({
        ok: true as const,
        imageBuffer: Buffer.from("x"),
        mimeType: "image/png",
        provider: "openai" as const,
        model: "test",
        usage: null,
      }),
      upload: async ({ index }) => ({ ok: true as const, url: `https://s/${index}.png`, path: `${index}.png` }),
      record: async () => undefined as never,
    }
  );

  assert(result.images.length === 1, `1장을 기대했는데 ${result.images.length}장입니다`);
  assert(result.images[0].index === 1, `자리 번호가 밀렸습니다(${result.images[0].index})`);
  assert(result.images[0].url === "https://s/1.png", "업로드 URL이 자리 번호와 맞지 않습니다");
  console.log("✅ 폴백 이미지가 원래 자리 번호에 붙는다");
}

console.log("\n🎉 폴백 이미지 테스트 통과");
