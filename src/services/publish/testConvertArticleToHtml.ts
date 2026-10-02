// convertArticleToHtml 테스트. 순수 변환 함수만 검증한다(네트워크/DB 없음).
// 간격·글자 크기는 renderPublishBlocks.ts가 정하고 testRenderPublishBlocks.ts가 따로 검증한다.
// 여기서는 **Blogspot 고유 선택**(strong/em, figure+figcaption, target=_blank)만 확인한다.
import { convertArticleToHtml } from "./convertArticleToHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ convertArticleToHtml 테스트 시작\n");

  // 1) **소제목** -> 19px <p><strong>, 본문은 별도 15px <p>(2026-10-02 발행 서식)
  const headings = convertArticleToHtml("**큰 소제목**\n본문 문단입니다.");
  assert(
    headings === '<p style="font-size:19px"><strong>큰 소제목</strong></p>\n<p style="font-size:15px">본문 문단입니다.</p>',
    `소제목+문단 변환 실패 (${headings})`
  );
  console.log("✅ **소제목** -> 19px <strong> 문단, 본문은 15px 문단");

  // 1-1) 소제목 뒤에 아무 문단도 없으면 소제목만(아래 빈 줄도 없다 - 규칙 3)
  const bareHeading = convertArticleToHtml("**혼자인 소제목**");
  assert(bareHeading === '<p style="font-size:19px"><strong>혼자인 소제목</strong></p>', `단독 소제목 실패 (${bareHeading})`);
  console.log("✅ 문단 없는 소제목 -> 소제목만 있는 <p>");

  // 1-2) 소제목 뒤가 목록이면(예: 참고 자료) 문단으로 뭉개지 않고 ul로 둔다
  const headingWithList = convertArticleToHtml("**참고 자료**\n- [링크1](https://a.com)\n- [링크2](https://b.com)");
  assert(headingWithList.includes('<p style="font-size:19px"><strong>참고 자료</strong></p>'), `헤더 변환 실패 (${headingWithList})`);
  assert(headingWithList.includes('<ul style="font-size:15px">'), `목록 변환 실패 (${headingWithList})`);
  assert(headingWithList.match(/<li>/g)?.length === 2, "목록 항목 2개 실패");
  console.log("✅ 소제목 다음 줄이 목록이면 ul로(문단으로 뭉개지 않음)");

  // 2) 이미지 -> figure/img/figcaption, src 유지(네이버 변환기와 달리 걷어내지 않는다)
  const img = convertArticleToHtml("![아기 손 사진](https://cdn.example.com/a.png)");
  assert(img.includes('<img src="https://cdn.example.com/a.png"'), `img src 유지 실패 (${img})`);
  assert(img.includes('<figcaption style="font-size:15px">아기 손 사진</figcaption>'), `alt -> figcaption 실패 (${img})`);
  assert(img.includes('loading="lazy"'), "lazy loading 속성 실패");
  console.log("✅ 이미지 -> figure + img(src 유지) + figcaption");

  // 2-1) [IMAGE: 설명] placeholder도 본문 문단으로(이미지 자동생성이 꺼진 경로)
  const placeholder = convertArticleToHtml("[IMAGE: 아기 손 사진 — 웹 검색]");
  assert(placeholder === '<p style="font-size:15px">[IMAGE: 아기 손 사진 — 웹 검색]</p>', `placeholder 실패 (${placeholder})`);
  console.log("✅ [IMAGE: 설명] placeholder도 본문 문단");

  // 3) 인라인: strong/em/a
  const inline = convertArticleToHtml("**굵게**와 *이탤릭*, [링크](https://example.com)입니다.");
  assert(inline.includes("<strong>굵게</strong>"), "strong 실패");
  assert(inline.includes("<em>이탤릭</em>"), "em 실패");
  assert(inline.includes('<a href="https://example.com" target="_blank" rel="noopener">링크</a>'), `a 실패 (${inline})`);
  console.log("✅ 인라인 strong/em/a(target=_blank)");

  // 4) 목록(소제목 없이 단독으로 오는 경우)
  const list = convertArticleToHtml("- 하나\n- 둘");
  assert(list === '<ul style="font-size:15px"><li>하나</li><li>둘</li></ul>', `목록 실패 (${list})`);
  console.log("✅ 목록 -> ul/li");

  // 5) HTML 이스케이프(본문에 < > & 가 있어도 안전)
  const escaped = convertArticleToHtml("a < b && c > d 인 경우");
  assert(escaped.includes("a &lt; b &amp;&amp; c &gt; d"), `이스케이프 실패 (${escaped})`);
  console.log("✅ 특수문자 이스케이프");

  // 6) FAQ/요약 소제목도 같은 규칙으로(별도 처리 없음)
  const faq = convertArticleToHtml("**자주 묻는 질문**\nQ. 언제인가요? 9월입니다.\n\n**요약**\n핵심 재진술.");
  assert(faq.includes("<strong>자주 묻는 질문</strong>") && faq.includes("<strong>요약</strong>"), "FAQ/요약 볼드 변환 실패");
  console.log("✅ FAQ/요약 소제목도 같은 볼드 규칙");

  console.log("\n✅ 전체 테스트 통과");
}

main();
