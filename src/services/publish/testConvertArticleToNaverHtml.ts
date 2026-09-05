// convertArticleToNaverHtml 테스트. 실제 브라우저/SmartEditor 없이 순수 변환 함수만 검증한다.

import { convertArticleToNaverHtml, stripImageMarkdownBlocks } from "./convertArticleToNaverHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ convertArticleToNaverHtml 테스트 시작\n");

  // 1) **소제목** -> <b>, 바로 다음 줄(빈 줄 없음)은 <br>로 붙은 같은 <p>(2026-09-06, writer.md §6)
  const withHeader = convertArticleToNaverHtml("**2026년 일정과 가격**\n본문 내용입니다.");
  assert(withHeader === "<p><b>2026년 일정과 가격</b><br>본문 내용입니다.</p>", `소제목+문단 결합 실패 (실제: ${withHeader})`);
  console.log("✅ **소제목** -> 문단과 <br>로 붙은 하나의 <p>(<b> 태그)");

  // 1-1) 소제목 뒤가 목록이면 별도 ul로 두되 margin을 서로 붙인다
  const headingWithList = convertArticleToNaverHtml("**참고 자료**\n- [링크1](https://a.com)\n- [링크2](https://b.com)");
  assert(headingWithList.includes('<p style="margin-bottom:0"><b>참고 자료</b></p>'), `헤더+목록의 헤더 margin 실패 (${headingWithList})`);
  assert(headingWithList.includes('<ul style="margin-top:0">'), `헤더+목록의 목록 margin 실패 (${headingWithList})`);
  console.log("✅ 소제목 다음 줄이 목록이면 ul로");

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

  // 4) ![alt](url) 이미지 -> img(2em 여백), (generateArticleImages.ts가 삽입하는 형식)
  const withImage = convertArticleToNaverHtml("![대표 이미지](https://example.com/a.png)");
  assert(
    withImage === '<img src="https://example.com/a.png" alt="대표 이미지" style="margin:2em 0">',
    `이미지 변환 실패 (실제: ${withImage})`
  );
  console.log("✅ ![alt](url) -> <img> 변환(2em 여백)");

  // 4-1) [IMAGE: 설명] placeholder도 여백을 받는다
  const placeholder = convertArticleToNaverHtml("[IMAGE: 대표 사진 — 웹 검색]");
  assert(placeholder === '<p style="margin:2em 0">[IMAGE: 대표 사진 — 웹 검색]</p>', `placeholder 여백 실패 (${placeholder})`);
  console.log("✅ [IMAGE: 설명] placeholder도 2em 여백");

  // 5) alt 텍스트가 비어 있어도 안전해야 한다
  const withEmptyAlt = convertArticleToNaverHtml("![](https://example.com/b.png)");
  assert(withEmptyAlt === '<img src="https://example.com/b.png" alt="" style="margin:2em 0">', `빈 alt 처리 실패 (실제: ${withEmptyAlt})`);
  console.log("✅ 빈 alt 텍스트 처리");

  // 6) HTML 특수문자 이스케이프 (본문에 <, >, & 등이 그대로 있으면 SmartEditor paste가 깨질 수 있다)
  const withSpecialChars = convertArticleToNaverHtml("가격은 5,000원 <10,000원 & 할인 적용");
  assert(
    withSpecialChars.includes("5,000원 &lt;10,000원 &amp; 할인 적용"),
    `특수문자 이스케이프 실패 (실제: ${withSpecialChars})`
  );
  console.log("✅ HTML 특수문자 이스케이프");

  // 7) 소제목 없는 한 블록 안 여러 줄은 <br>로 보존
  const withMultiline = convertArticleToNaverHtml("질문입니다.\n답변입니다.");
  assert(withMultiline === "<p>질문입니다.<br>답변입니다.</p>", `<br> 보존 실패 (실제: ${withMultiline})`);
  console.log("✅ 블록 내 줄바꿈 -> <br> 보존");

  // 8) 여러 블록이 섞인 실제 원고 형태 회귀 케이스
  const fullArticle = [
    "**신청 기간과 대상**\n2026년 9월 1일부터 접수를 시작합니다.",
    "![대표 이미지](https://example.com/main.png)",
    "- 신청 자격: 만 19세 이상\n- 신청 방법: 온라인 접수",
  ].join("\n\n");
  const fullHtml = convertArticleToNaverHtml(fullArticle);
  const blocks = fullHtml.split("\n");
  assert(blocks.length === 3, `블록 3개여야 한다 (실제: ${blocks.length}개)`);
  assert(blocks[0] === "<p><b>신청 기간과 대상</b><br>2026년 9월 1일부터 접수를 시작합니다.</p>", `블록 순서 오류: ${blocks[0]}`);
  assert(blocks[1] === '<img src="https://example.com/main.png" alt="대표 이미지" style="margin:2em 0">', `블록 순서 오류: ${blocks[1]}`);
  assert(blocks[2].startsWith("<ul>"), `블록 순서 오류: ${blocks[2]}`);
  console.log("✅ 헤더+문단 결합 + 이미지 + 목록이 섞인 전체 원고 변환");

  // 9) stripImageMarkdownBlocks - 이미지 블록만 제거, 나머지는 그대로 유지
  const withImageInMiddle = [
    "**첫 섹션**\n첫 섹션 본문입니다.",
    "![중간 이미지](https://example.com/mid.png)",
    "**둘째 섹션**\n둘째 섹션 본문입니다.",
  ].join("\n\n");
  const stripped = stripImageMarkdownBlocks(withImageInMiddle);
  assert(!stripped.includes("![중간 이미지]"), `이미지 블록이 제거돼야 한다 (실제: ${stripped})`);
  assert(stripped.includes("**첫 섹션**") && stripped.includes("**둘째 섹션**"), `나머지 블록은 유지돼야 한다 (실제: ${stripped})`);
  console.log("✅ stripImageMarkdownBlocks - 이미지 블록만 제거");

  // 10) 이미지가 없는 본문은 그대로 유지
  const noImage = "그냥 평범한 문단입니다.";
  assert(stripImageMarkdownBlocks(noImage) === noImage, "이미지 없는 본문은 변형되면 안 된다");
  console.log("✅ stripImageMarkdownBlocks - 이미지 없으면 원본 그대로");

  console.log("\n✅ 전체 테스트 통과");
}

main();
