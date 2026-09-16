import { manuscriptBodyWithoutImages, parseManuscriptBlocks, substituteConfirmedImages } from "./parseManuscriptBlocks.js";
import type { ManuscriptImage } from "./manuscriptManifest.js";

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

  // 1-1) 획득 방식(output-format.md §8)을 설명에서 읽는다. 이게 없으면 generateManuscriptImages가
  //      웹 검색 마커의 한국어 검색어까지 이미지 모델에 넣는다(2026-09-16 실측 사고).
  assert(blocks[1].type === "image" && blocks[1].acquisition === "search", "`— 웹 검색`은 search여야 한다");
  assert(blocks[3].type === "image" && blocks[3].acquisition === "ai", "`— AI 생성`은 ai여야 한다");

  const acquisitions = parseManuscriptBlocks(
    [
      "[IMAGE: 표기 없는 옛 원고 마커]",
      "",
      "[IMAGE: 기상청 브리핑 사진 - 웹검색, 출처 표기 필요]",
      "",
      "[IMAGE: 루틴 카드 – ai 생성]",
    ].join("\n")
  ).filter((b) => b.type === "image");
  assert(acquisitions[0].type === "image" && acquisitions[0].acquisition === "unknown", "표기 없으면 unknown(옛 원고 호환)");
  assert(
    acquisitions[1].type === "image" && acquisitions[1].acquisition === "search",
    "대시 종류·띄어쓰기·뒤 단서가 달라도 웹 검색을 잡아야 한다"
  );
  assert(acquisitions[2].type === "image" && acquisitions[2].acquisition === "ai", "소문자 ai 생성도 잡아야 한다");
  console.log("✅ 획득 방식 파싱(웹 검색/AI 생성/표기 없음, 표기 흔들림 허용)");

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

  // 7) [IMAGE:] 바로 다음 줄에 [IMAGE PROMPT:]가 이미 붙어 저장된 경우(2026-09-15 발견 -
  //    옥토버페스트/추석/광안리드론쇼 3건에서 실제로 이 형태였고, 이미지 블록으로 인식되지 않아
  //    이미지 캡션 표·프롬프트 팩 버튼이 통째로 안 떴다)도 이미지 블록으로 인식하고, 인라인
  //    프롬프트를 그대로 써야 한다(imagePrompts 배열은 아예 안 넘겨도 됨 - 인라인이 우선).
  const inlinePromptBody = [
    "도입부 문단입니다.",
    "",
    "[IMAGE: 카페 사진 — 웹 검색]",
    "[IMAGE PROMPT: 서울 카페 아메리카노 감성 사진]",
    "",
    "마무리 문단입니다.",
  ].join("\n");
  const inlineBlocks = parseManuscriptBlocks(inlinePromptBody);
  const inlineImages = inlineBlocks.filter((b) => b.type === "image");
  assert(inlineImages.length === 1, `인라인 IMAGE PROMPT도 이미지 블록 1개로 인식해야 한다 (실제: ${inlineImages.length})`);
  assert(
    inlineImages[0].type === "image" && inlineImages[0].prompt === "서울 카페 아메리카노 감성 사진",
    "인라인 IMAGE PROMPT 텍스트를 그대로 써야 한다"
  );
  assert(inlineBlocks.length === 3, `텍스트/이미지/텍스트 3블록이어야 한다 (실제: ${inlineBlocks.length})`);
  console.log("✅ [IMAGE:]+[IMAGE PROMPT:] 인라인 결합도 이미지 블록으로 인식 + 인라인 프롬프트 사용");

  // 8) manuscriptBodyWithoutImages도 인라인 IMAGE PROMPT 줄까지 함께 제거해야 한다.
  const inlineWithoutImages = manuscriptBodyWithoutImages(inlinePromptBody);
  assert(!inlineWithoutImages.includes("[IMAGE"), "인라인 IMAGE PROMPT 줄이 제거되지 않음");
  console.log("✅ manuscriptBodyWithoutImages - 인라인 IMAGE PROMPT 줄도 함께 제거");

  // 9) substituteConfirmedImages - Blogspot 자동 발행 전처리. 각 마커 위치에 확정 이미지(url
  //    있음)가 정확히 1장이면 실제 `![설명](url)`로 바꾼다.
  const imageBody = [
    "도입부 문단입니다.",
    "",
    "[IMAGE: 카페 사진 — 웹 검색]",
    "",
    "**소제목**",
    "문단입니다.",
    "",
    "[IMAGE: 골목 일러스트 — AI 생성]",
  ].join("\n");

  const oneConfirmed: ManuscriptImage[] = [
    { index: 1, description: "카페 사진 — 웹 검색", prompt: null, url: "https://x/1.png", provider: "openai", fileName: "01.png" },
  ];
  const substituted1 = substituteConfirmedImages(imageBody, oneConfirmed);
  assert(substituted1.includes("![카페 사진 — 웹 검색](https://x/1.png)"), "확정 이미지 1장은 마크다운 이미지로 치환돼야 한다");
  assert(substituted1.includes("[IMAGE: 골목 일러스트"), "확정 안 된(0장) 마커는 그대로 남아야 한다");
  console.log("✅ substituteConfirmedImages - 확정 1장만 치환, 미확정 마커는 유지");

  // 10) A/B 비교로 같은 인덱스에 후보가 2장(둘 다 url 있음) -> 아직 사람이 안 골랐으니 치환 안 함.
  const abCandidates: ManuscriptImage[] = [
    { index: 1, description: "카페 사진", prompt: null, url: "https://x/a.png", provider: "openai", fileName: "01-openai.png" },
    { index: 1, description: "카페 사진", prompt: null, url: "https://x/b.png", provider: "gemini", fileName: "01-gemini.png" },
  ];
  const substituted2 = substituteConfirmedImages(imageBody, abCandidates);
  assert(substituted2.includes("[IMAGE: 카페 사진"), "A/B 후보 2장(미확정)은 마커를 그대로 둬야 한다");
  console.log("✅ substituteConfirmedImages - A/B 미확정(후보 2장)은 마커 유지");

  // 11) 생성 실패(url null)만 있으면 확정 0장 -> 마커 유지.
  const failedOnly: ManuscriptImage[] = [
    { index: 1, description: "카페 사진", prompt: null, url: null, provider: "openai", fileName: "01.png", error: "생성 실패" },
  ];
  const substituted3 = substituteConfirmedImages(imageBody, failedOnly);
  assert(substituted3.includes("[IMAGE: 카페 사진"), "url 없는(실패) 이미지는 치환하면 안 된다");
  console.log("✅ substituteConfirmedImages - 생성 실패(url 없음)는 마커 유지");

  console.log("\n✅ parseManuscriptBlocks 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
