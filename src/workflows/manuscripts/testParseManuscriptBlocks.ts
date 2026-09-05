import { manuscriptBodyWithoutImages, parseManuscriptBlocks } from "./parseManuscriptBlocks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ parseManuscriptBlocks 테스트 시작\n");

  // 실제 파이프라인 데이터 모양: 본문엔 [IMAGE: 설명] 단독 줄만 있고(parseDraftFile.ts가
  // [IMAGE PROMPT:] 줄은 이미 빼서 metadata.imagePrompts로 옮겨 둔다), 프롬프트는 등장 순서로
  // 짝을 맞춘다.
  const body = [
    "첫 문단입니다.",
    "",
    "[IMAGE: 카페에서 커피 마시는 사진 — 웹 검색]",
    "",
    "둘째 문단입니다.",
    "",
    "[IMAGE: 노을 지는 골목 데이트 일러스트 — AI 생성]",
    "",
    "셋째 문단입니다.",
  ].join("\n");
  const prompts = ["서울 카페 아메리카노 감성 사진", "A warm minimal flat illustration of a couple on a quiet date at dusk."];

  // 1) 텍스트-이미지-텍스트-이미지-텍스트, 등장 순서대로 프롬프트 매칭
  const blocks = parseManuscriptBlocks(body, prompts);
  assert(blocks.length === 5, `블록 수 실패 (${blocks.length})`);
  assert(blocks[0].type === "text" && blocks[0].content === "첫 문단입니다.", "첫 텍스트 블록 실패");
  assert(
    blocks[1].type === "image" && blocks[1].description === "카페에서 커피 마시는 사진 — 웹 검색" && blocks[1].prompt === prompts[0],
    "첫 이미지 블록 매칭 실패"
  );
  assert(blocks[2].type === "text" && blocks[2].content === "둘째 문단입니다.", "둘째 텍스트 블록 실패");
  assert(blocks[3].type === "image" && blocks[3].prompt === prompts[1], "둘째 이미지 블록 매칭 실패");
  assert(blocks[4].type === "text" && blocks[4].content === "셋째 문단입니다.", "셋째 텍스트 블록 실패");
  console.log("✅ 텍스트/이미지 교차 - 등장 순서대로 imagePrompts 매칭");

  // 2) 마커 개수와 imagePrompts 길이가 다르면(배리에이션이 마커를 빠뜨리는 등) 프롬프트 없이 표시
  const mismatched = parseManuscriptBlocks(body, ["프롬프트 1개뿐"]);
  const images = mismatched.filter((b) => b.type === "image");
  assert(images.length === 2 && images.every((b) => b.type === "image" && b.prompt === null), "개수 불일치 시 프롬프트를 비워야 한다");
  console.log("✅ 마커 개수 불일치 -> 프롬프트 미상(null) 처리");

  // 3) imagePrompts 없이 호출(기본값) -> 설명만, 프롬프트 null
  const noPrompts = parseManuscriptBlocks(body);
  assert(noPrompts.filter((b) => b.type === "image").every((b) => b.type === "image" && b.prompt === null), "prompts 미전달 시 null이어야 한다");
  console.log("✅ imagePrompts 생략 -> 프롬프트 null");

  // 4) 이미지 마커 연속 2개(사이 텍스트 없음)
  const consecutive = ["[IMAGE: 첫 번째 — 웹 검색]", "[IMAGE: 두 번째 — AI 생성]"].join("\n");
  const consecutiveBlocks = parseManuscriptBlocks(consecutive, ["p1", "p2"]);
  assert(consecutiveBlocks.length === 2 && consecutiveBlocks.every((b) => b.type === "image"), "연속 마커 처리 실패");
  console.log("✅ 이미지 마커 연속 2개");

  // 5) 마커 없는 본문 -> 텍스트 블록 1개
  const plain = "그냥 평범한 본문입니다.";
  const plainBlocks = parseManuscriptBlocks(plain);
  assert(plainBlocks.length === 1 && plainBlocks[0].type === "text", "마커 없는 본문 실패");
  console.log("✅ 마커 없는 본문 -> 텍스트 블록 1개");

  // 6) manuscriptBodyWithoutImages - 마커 줄 제거, 본문 텍스트 유지
  const withoutImages = manuscriptBodyWithoutImages(body);
  assert(!withoutImages.includes("[IMAGE"), "이미지 마커가 제거되지 않음");
  assert(withoutImages.includes("첫 문단입니다.") && withoutImages.includes("셋째 문단입니다."), "본문 텍스트가 유실됨");
  console.log("✅ manuscriptBodyWithoutImages - 마커 제거, 본문 유지");

  console.log("\n✅ parseManuscriptBlocks 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
