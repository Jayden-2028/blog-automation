// buildImageBrief 테스트. generateBrief를 주입해 실제 LLM을 호출하지 않는다.

import { buildImageBrief, IMAGE_BRIEF_MARKERS } from "./buildImageBrief.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const INPUT = { title: "아이폰18·첫 폴더블 아이폰 출시일 정리", keyword: "아이폰18 폴더블", category: "living" };

const WELL_FORMED = [
  IMAGE_BRIEF_MARKERS.scene,
  "접힌 스마트폰의 실루엣을 미니멀하게, 파란 계열 그라데이션 배경",
  "",
  IMAGE_BRIEF_MARKERS.prompt,
  "A minimal illustration of a folding smartphone silhouette, blue gradient background, no text, no logos",
  "",
  IMAGE_BRIEF_MARKERS.altText,
  "폴더블 스마트폰을 형상화한 일러스트",
  "",
  IMAGE_BRIEF_MARKERS.prohibited,
  "실제 애플 제품 사진, 애플 로고, 실존 인물",
].join("\n");

async function main(): Promise<void> {
  console.log("▶ buildImageBrief 테스트 시작\n");

  // 1) 정상 출력을 4개 필드로 정확히 나눈다.
  const ok = await buildImageBrief(INPUT, { generateBrief: async () => ({ ok: true, output: WELL_FORMED }) });
  assert(ok.ok, "정상 출력이면 ok:true여야 한다");
  if (ok.ok) {
    assert(ok.brief.scene.includes("파란 계열 그라데이션"), `scene 파싱 실패: ${ok.brief.scene}`);
    assert(ok.brief.prompt.startsWith("A minimal illustration"), `prompt 파싱 실패: ${ok.brief.prompt}`);
    assert(ok.brief.altText === "폴더블 스마트폰을 형상화한 일러스트", `altText 파싱 실패: ${ok.brief.altText}`);
    assert(ok.brief.prohibited.includes("애플 로고"), `prohibited 파싱 실패: ${ok.brief.prohibited}`);
  }
  console.log("✅ 정상 출력 -> scene/prompt/altText/prohibited 4개 필드로 파싱");

  // 2) 프롬프트에 제목/키워드/분야가 실제로 포함돼야 한다(모델이 참고할 재료).
  let capturedPrompt = "";
  await buildImageBrief(INPUT, {
    generateBrief: async (prompt) => {
      capturedPrompt = prompt;
      return { ok: true, output: WELL_FORMED };
    },
  });
  assert(capturedPrompt.includes("아이폰18"), "프롬프트에 키워드가 포함돼야 한다");
  assert(capturedPrompt.includes("living"), "프롬프트에 분야가 포함돼야 한다");
  assert(capturedPrompt.includes("실존 인물"), "프롬프트에 금지 항목 지시(실존 인물 등)가 있어야 한다");
  console.log("✅ 프롬프트에 제목/키워드/분야/금지 항목 지시 포함");

  // 3) LLM 호출 실패는 예외 없이 ok:false.
  const failed = await buildImageBrief(INPUT, {
    generateBrief: async () => ({ ok: false, error: "claude가 종료 코드 1로 끝났습니다" }),
  });
  assert(!failed.ok, "LLM 실패면 ok:false여야 한다");
  if (!failed.ok) assert(failed.error.includes("종료 코드"), "실패 사유가 그대로 전달돼야 한다");
  console.log("✅ LLM 호출 실패 -> 예외 없이 ok:false");

  // 4) SCENE/PROMPT가 없는 출력(모델이 형식을 안 지킨 경우)은 파싱 실패로 취급한다.
  const noMarkers = await buildImageBrief(INPUT, {
    generateBrief: async () => ({ ok: true, output: "그냥 자유 형식으로 답했습니다." }),
  });
  assert(!noMarkers.ok, "마커 없는 출력은 ok:false여야 한다");
  console.log("✅ 마커 없는 출력 -> ok:false(브리프로 쓸 수 없음)");

  // 5) ALT_TEXT/PROHIBITED가 없어도(SCENE/PROMPT만 있어도) 브리프는 살린다 - 사람이 채울 수 있는 항목이다.
  const partial = [IMAGE_BRIEF_MARKERS.scene, "장면만 있음", "", IMAGE_BRIEF_MARKERS.prompt, "prompt only"].join("\n");
  const partialResult = await buildImageBrief(INPUT, { generateBrief: async () => ({ ok: true, output: partial }) });
  assert(partialResult.ok, "SCENE/PROMPT만 있어도 성공해야 한다");
  if (partialResult.ok) {
    assert(partialResult.brief.altText === "", "없는 필드는 빈 문자열이어야 한다(죽지 않는다)");
  }
  console.log("✅ ALT_TEXT/PROHIBITED 없어도 SCENE/PROMPT만으로 브리프 유지");

  console.log("\n✅ buildImageBrief 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
