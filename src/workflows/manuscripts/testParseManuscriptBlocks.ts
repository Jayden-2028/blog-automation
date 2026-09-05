import { manuscriptBodyWithoutImages, parseManuscriptBlocks } from "./parseManuscriptBlocks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ parseManuscriptBlocks 테스트 시작\n");

  // 실제 파이프라인 데이터 모양(2026-09-06, writer.md §6): 소제목은 "**볼드**" 단독 줄이고
  // 바로 다음 줄(빈 줄 없음)에 그 소제목의 문단이 붙는다. [IMAGE: 설명] 단독 줄만 있고(프롬프트는
  // job.metadata.imagePrompts로 분리) 등장 순서로 짝을 맞춘다.
  const body = [
    "도입부 문단입니다.",
    "",
    "[IMAGE: 카페에서 커피 마시는 사진 — 웹 검색]",
    "",
    "**첫 번째 소제목**",
    "첫 번째 소제목에 바로 붙는 문단입니다.",
    "",
    "[IMAGE: 노을 지는 골목 데이트 일러스트 — AI 생성]",
    "",
    "**참고 자료**",
    "- [링크1](https://a.com)",
    "- [링크2](https://b.com)",
  ].join("\n");
  const prompts = ["서울 카페 아메리카노 감성 사진", "A warm minimal flat illustration of a couple on a quiet date at dusk."];

  const blocks = parseManuscriptBlocks(body, prompts);
  assert(blocks.length === 5, `블록 5개여야 한다 (실제: ${blocks.length})`);

  assert(blocks[0].type === "text" && blocks[0].content === "도입부 문단입니다.", "도입부 텍스트 블록 실패");

  assert(blocks[1].type === "image" && blocks[1].prompt === prompts[0], "첫 이미지 블록 매칭 실패");

  assert(
    blocks[2].type === "heading" && blocks[2].heading === "첫 번째 소제목" && blocks[2].body === "첫 번째 소제목에 바로 붙는 문단입니다.",
    `소제목+문단 결합 실패 (${JSON.stringify(blocks[2])})`
  );

  assert(blocks[3].type === "image" && blocks[3].prompt === prompts[1], "둘째 이미지 블록 매칭 실패");

  assert(
    blocks[4].type === "heading" && blocks[4].heading === "참고 자료" && blocks[4].body.includes("- [링크1]"),
    `소제목+목록 결합 실패 (${JSON.stringify(blocks[4])})`
  );
  console.log("✅ 텍스트/이미지/소제목+문단/소제목+목록 - 블록 분할과 프롬프트 매칭");

  // 2) 마커 개수와 imagePrompts 길이가 다르면(배리에이션이 마커를 빠뜨리는 등) 프롬프트 없이 표시
  const mismatched = parseManuscriptBlocks(body, ["프롬프트 1개뿐"]);
  const images = mismatched.filter((b) => b.type === "image");
  assert(images.length === 2 && images.every((b) => b.type === "image" && b.prompt === null), "개수 불일치 시 프롬프트를 비워야 한다");
  console.log("✅ 마커 개수 불일치 -> 프롬프트 미상(null) 처리");

  // 3) imagePrompts 없이 호출(기본값) -> 프롬프트 null
  const noPrompts = parseManuscriptBlocks(body);
  assert(noPrompts.filter((b) => b.type === "image").every((b) => b.type === "image" && b.prompt === null), "prompts 미전달 시 null이어야 한다");
  console.log("✅ imagePrompts 생략 -> 프롬프트 null");

  // 4) 소제목 뒤에 아무 문단도 없으면 body는 빈 문자열
  const bareHeading = parseManuscriptBlocks("**혼자인 소제목**");
  assert(bareHeading.length === 1 && bareHeading[0].type === "heading" && bareHeading[0].body === "", "단독 소제목 처리 실패");
  console.log("✅ 문단 없는 소제목 -> body 빈 문자열");

  // 5) 마커 없는 본문 -> 텍스트 블록 1개
  const plain = "그냥 평범한 본문입니다.";
  const plainBlocks = parseManuscriptBlocks(plain);
  assert(plainBlocks.length === 1 && plainBlocks[0].type === "text", "마커 없는 본문 실패");
  console.log("✅ 마커/소제목 없는 본문 -> 텍스트 블록 1개");

  // 6) manuscriptBodyWithoutImages - 마커 줄 제거, 본문 텍스트 유지
  const withoutImages = manuscriptBodyWithoutImages(body);
  assert(!withoutImages.includes("[IMAGE"), "이미지 마커가 제거되지 않음");
  assert(withoutImages.includes("도입부 문단입니다.") && withoutImages.includes("첫 번째 소제목"), "본문 텍스트가 유실됨");
  console.log("✅ manuscriptBodyWithoutImages - 마커 제거, 본문 유지");

  console.log("\n✅ parseManuscriptBlocks 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
