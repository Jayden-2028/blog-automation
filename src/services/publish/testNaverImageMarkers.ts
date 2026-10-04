// 네이버 이미지 자리 표식 변환 테스트. 브라우저 없이 "무엇을 붙여넣고 무엇을 업로드할지"만 고정한다.
//
// 핵심은 두 경로가 **갈라졌다**는 것이다(2026-10-04):
//   - 발행 버튼 경로(convertArticleToNaverPaste): 이미지를 표식으로 → 에디터에 직접 업로드
//   - 사람이 뷰어에서 복사하는 경로(convertArticleToNaverHtml): 이미지가 눈에 보여야 하므로 <img> 유지

import { convertArticleToNaverHtml, convertArticleToNaverPaste } from "./convertArticleToNaverHtml.js";
import { ANY_IMAGE_MARKER, extractImageMarkers, imageMarker } from "./naverImageMarkers.js";
import { SPACER_HTML } from "./renderPublishBlocks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const IMG1 = "https://x.supabase.co/storage/v1/object/public/article-images/1.png";
const IMG2 = "https://x.supabase.co/storage/v1/object/public/article-images/2.png";

const MARKDOWN = [
  "첫 문단입니다. 여기서 글이 시작됩니다.",
  `![정해인과 신세경의 투샷](${IMG1})`,
  "**소제목 한 줄**\n소제목 바로 아래 문단입니다.",
  `![두 번째 이미지](${IMG2})`,
  "#태그하나 #태그둘",
].join("\n\n");

async function main(): Promise<void> {
  console.log("▶ naverImageMarkers 테스트 시작\n");

  // 1) 이미지 블록이 표식으로 바뀌고 등장 순서대로 수집된다
  const extracted = extractImageMarkers(MARKDOWN);
  assert(extracted.images.length === 2, `이미지 2장을 모아야 한다(실제: ${extracted.images.length})`);
  assert(extracted.images[0].marker === imageMarker(1), "첫 이미지는 1번 표식");
  assert(extracted.images[1].marker === imageMarker(2), "둘째 이미지는 2번 표식");
  assert(extracted.images[0].url === IMG1 && extracted.images[1].url === IMG2, "URL이 순서대로 보존돼야 한다");
  assert(extracted.images[0].alt === "정해인과 신세경의 투샷", "alt(캡션)가 보존돼야 한다");
  assert(!extracted.markdown.includes("!["), "마크다운에 이미지 문법이 남으면 안 된다");
  console.log("✅ 이미지 블록 → 표식 + 순서대로 수집");

  // 2) 붙여넣을 HTML에는 <img>가 없고 표식만 있다
  const paste = convertArticleToNaverPaste(MARKDOWN);
  assert(!paste.html.includes("<img"), `붙여넣기 HTML에 <img>가 없어야 한다 (실제: ${paste.html})`);
  assert(paste.html.includes(imageMarker(1)) && paste.html.includes(imageMarker(2)), "표식이 HTML에 있어야 한다");
  assert(paste.images.length === 2, "업로드 목록이 함께 나와야 한다");
  console.log("✅ 붙여넣기 HTML - <img> 없음 + 표식 포함 + 업로드 목록 동반");

  // 3) 사람이 복사하는 경로는 그대로 <img>를 낸다(두 경로가 갈라졌다는 것을 고정)
  const copyHtml = convertArticleToNaverHtml(MARKDOWN);
  assert(copyHtml.includes(`<img src="${IMG1}"`), "복사용 HTML은 <img>를 유지해야 한다");
  assert(!ANY_IMAGE_MARKER.test(copyHtml), "복사용 HTML에 표식이 들어가면 안 된다");
  console.log("✅ 뷰어 복사 경로 - <img> 유지(표식 없음)");

  // 4) 간격 규칙이 깨지지 않는다 - 표식 문단 뒤에도 빈 문단 1개
  const lines = paste.html.split("\n");
  const markerLine = lines.findIndex((line) => line.includes(imageMarker(1)));
  assert(markerLine >= 0, "표식 줄을 찾아야 한다");
  assert(lines[markerLine + 1] === SPACER_HTML, "표식 문단 뒤에는 빈 문단 1개(규칙 4와 같은 간격)");
  assert(lines[markerLine + 2] !== SPACER_HTML, "빈 문단이 2개가 되면 간격이 벌어진다");
  console.log("✅ 간격 규칙 유지 - 표식 문단 뒤 빈 줄 1개");

  // 5) 소제목 서식은 영향 없다
  assert(paste.html.includes("font-size:19px"), "소제목 크기는 그대로여야 한다");
  assert(paste.html.includes("<b>소제목 한 줄</b>"), "소제목 굵게는 그대로여야 한다");
  console.log("✅ 소제목 서식 영향 없음");

  // 6) 괄호가 든 URL도 끊기지 않는다(2026-10-03 위키백과 404 버그 회귀 고정)
  const parenUrl = "https://ko.wikipedia.org/wiki/룩백_(2026년_영화)";
  const parenResult = extractImageMarkers(`![포스터](${parenUrl})`);
  assert(parenResult.images.length === 1, "괄호 URL 이미지도 잡혀야 한다");
  assert(parenResult.images[0].url === parenUrl, `URL 끝의 괄호가 보존돼야 한다 (실제: ${parenResult.images[0].url})`);
  console.log("✅ 괄호 포함 URL 보존");

  // 7) 이미지가 없는 원고는 아무것도 바뀌지 않는다
  const plain = "이미지 없는 짧은 글입니다.\n\n#태그";
  const plainResult = extractImageMarkers(plain);
  assert(plainResult.images.length === 0, "이미지가 없으면 빈 목록");
  assert(plainResult.markdown === plain, "본문이 그대로여야 한다");
  console.log("✅ 이미지 없는 원고 - 변화 없음");

  // 8) 문단 가운데 섞인 이미지 문법은 건드리지 않는다(원고 규격상 이미지는 한 줄 블록이다)
  const inline = `문장 안에 ![그림](${IMG1}) 이 섞여 있습니다.`;
  const inlineResult = extractImageMarkers(inline);
  assert(inlineResult.images.length === 0, "한 줄 블록이 아닌 이미지는 수집 대상이 아니다");
  assert(inlineResult.markdown === inline, "문단이 그대로여야 한다");
  console.log("✅ 문단 중간 이미지 문법 - 손대지 않음");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
