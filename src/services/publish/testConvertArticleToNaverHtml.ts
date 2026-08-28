// convertArticleToNaverHtml 테스트. 실제 브라우저/SmartEditor 없이 순수 변환 함수만 검증한다.

import { convertArticleToNaverHtml, stripImageMarkdownBlocks } from "./convertArticleToNaverHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ convertArticleToNaverHtml 테스트 시작\n");

  // 1) ## 소제목 -> h3
  const withHeader = convertArticleToNaverHtml("## 2026년 일정과 가격\n\n본문 내용입니다.");
  assert(withHeader.includes("<h3>2026년 일정과 가격</h3>"), `h3 변환 실패 (실제: ${withHeader})`);
  assert(withHeader.includes("<p>본문 내용입니다.</p>"), `p 변환 실패 (실제: ${withHeader})`);
  console.log("✅ ## 소제목 -> <h3> 변환");

  // 2) **굵게**, *이탤릭*, 링크
  const withInline = convertArticleToNaverHtml("**굵게**와 *이탤릭*, 그리고 [링크](https://example.com)입니다.");
  assert(withInline.includes("<b>굵게</b>"), "굵게 변환 실패");
  assert(withInline.includes("<i>이탤릭</i>"), "이탤릭 변환 실패");
  assert(withInline.includes('<a href="https://example.com">링크</a>'), "링크 변환 실패");
  console.log("✅ 인라인 서식(굵게/이탤릭/링크) 변환");

  // 3) - 목록 -> ul/li
  const withList = convertArticleToNaverHtml("- 첫째 항목\n- 둘째 항목");
  assert(withList.includes("<ul><li>첫째 항목</li><li>둘째 항목</li></ul>"), `목록 변환 실패 (실제: ${withList})`);
  console.log("✅ 목록 -> <ul><li> 변환");

  // 4) ![alt](url) 이미지 -> img (generateArticleImages.ts가 삽입하는 형식)
  const withImage = convertArticleToNaverHtml("![대표 이미지](https://example.com/a.png)");
  assert(
    withImage === '<img src="https://example.com/a.png" alt="대표 이미지">',
    `이미지 변환 실패 (실제: ${withImage})`
  );
  console.log("✅ ![alt](url) -> <img> 변환");

  // 5) alt 텍스트가 비어 있어도 안전해야 한다
  const withEmptyAlt = convertArticleToNaverHtml("![](https://example.com/b.png)");
  assert(withEmptyAlt === '<img src="https://example.com/b.png" alt="">', `빈 alt 처리 실패 (실제: ${withEmptyAlt})`);
  console.log("✅ 빈 alt 텍스트 처리");

  // 6) HTML 특수문자 이스케이프 (본문에 <, >, & 등이 그대로 있으면 SmartEditor paste가 깨질 수 있다)
  const withSpecialChars = convertArticleToNaverHtml("가격은 5,000원 <10,000원 & 할인 적용");
  assert(
    withSpecialChars.includes("5,000원 &lt;10,000원 &amp; 할인 적용"),
    `특수문자 이스케이프 실패 (실제: ${withSpecialChars})`
  );
  console.log("✅ HTML 특수문자 이스케이프");

  // 7) 한 블록 안 여러 줄은 <br>로 보존 (FAQ 형식 등)
  const withMultiline = convertArticleToNaverHtml("질문입니다.\n답변입니다.");
  assert(withMultiline === "<p>질문입니다.<br>답변입니다.</p>", `<br> 보존 실패 (실제: ${withMultiline})`);
  console.log("✅ 블록 내 줄바꿈 -> <br> 보존");

  // 8) 여러 블록이 섞인 실제 원고 형태 회귀 케이스
  const fullArticle = [
    "## 신청 기간과 대상",
    "2026년 9월 1일부터 접수를 시작합니다.",
    "![대표 이미지](https://example.com/main.png)",
    "- 신청 자격: 만 19세 이상\n- 신청 방법: 온라인 접수",
  ].join("\n\n");
  const fullHtml = convertArticleToNaverHtml(fullArticle);
  const blocks = fullHtml.split("\n");
  assert(blocks.length === 4, `블록 4개여야 한다 (실제: ${blocks.length}개)`);
  assert(blocks[0] === "<h3>신청 기간과 대상</h3>", `블록 순서 오류: ${blocks[0]}`);
  assert(blocks[1] === "<p>2026년 9월 1일부터 접수를 시작합니다.</p>", `블록 순서 오류: ${blocks[1]}`);
  assert(blocks[2] === '<img src="https://example.com/main.png" alt="대표 이미지">', `블록 순서 오류: ${blocks[2]}`);
  assert(blocks[3].startsWith("<ul>"), `블록 순서 오류: ${blocks[3]}`);
  console.log("✅ 헤더+문단+이미지+목록이 섞인 전체 원고 변환");

  // 9) stripImageMarkdownBlocks - 이미지 블록만 제거, 나머지는 그대로 유지
  const withImageInMiddle = [
    "## 첫 섹션",
    "첫 섹션 본문입니다.",
    "![중간 이미지](https://example.com/mid.png)",
    "## 둘째 섹션",
    "둘째 섹션 본문입니다.",
  ].join("\n\n");
  const stripped = stripImageMarkdownBlocks(withImageInMiddle);
  assert(!stripped.includes("![중간 이미지]"), `이미지 블록이 제거돼야 한다 (실제: ${stripped})`);
  assert(stripped.includes("## 첫 섹션") && stripped.includes("## 둘째 섹션"), `나머지 블록은 유지돼야 한다 (실제: ${stripped})`);
  console.log("✅ stripImageMarkdownBlocks - 이미지 블록만 제거");

  // 10) 이미지가 없는 본문은 그대로 유지
  const noImage = "그냥 평범한 문단입니다.";
  assert(stripImageMarkdownBlocks(noImage) === noImage, "이미지 없는 본문은 변형되면 안 된다");
  console.log("✅ stripImageMarkdownBlocks - 이미지 없으면 원본 그대로");

  console.log("\n✅ 전체 테스트 통과");
}

main();
