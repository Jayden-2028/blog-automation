// convertArticleToHtml 테스트. 순수 변환 함수만 검증한다(네트워크/DB 없음).
import { convertArticleToHtml } from "./convertArticleToHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ convertArticleToHtml 테스트 시작\n");

  // 1) **소제목** -> <p><strong>, 바로 다음 줄(빈 줄 없음)은 <br>로 붙은 같은 <p>(2026-09-06, writer.md §6)
  const headings = convertArticleToHtml("**큰 소제목**\n본문 문단입니다.");
  assert(headings.includes("<p><strong>큰 소제목</strong><br>본문 문단입니다.</p>"), `소제목+문단 결합 실패 (${headings})`);
  console.log("✅ **소제목** -> 문단과 <br>로 붙은 하나의 <p>");

  // 1-1) 소제목 뒤에 아무 문단도 없으면 소제목만 있는 <p>
  const bareHeading = convertArticleToHtml("**혼자인 소제목**");
  assert(bareHeading === "<p><strong>혼자인 소제목</strong></p>", `단독 소제목 실패 (${bareHeading})`);
  console.log("✅ 문단 없는 소제목 -> 소제목만 있는 <p>");

  // 1-2) 소제목 뒤가 목록이면(예: 참고 자료) 별도 ul로 두되 margin을 서로 붙인다
  const headingWithList = convertArticleToHtml("**참고 자료**\n- [링크1](https://a.com)\n- [링크2](https://b.com)");
  assert(headingWithList.includes('<p style="margin-bottom:0"><strong>참고 자료</strong></p>'), `헤더+목록의 헤더 margin 실패 (${headingWithList})`);
  assert(headingWithList.includes('<ul style="margin-top:0">'), `헤더+목록의 목록 margin 실패 (${headingWithList})`);
  assert(headingWithList.includes("<li>") && headingWithList.match(/<li>/g)?.length === 2, "목록 항목 2개 실패");
  console.log("✅ 소제목 다음 줄이 목록이면 ul로(문단으로 뭉개지 않음)");

  // 2) 이미지 -> figure/img/figcaption, src 유지(네이버 변환기와 달리 걷어내지 않는다), 여백 2em
  const img = convertArticleToHtml("![아기 손 사진](https://cdn.example.com/a.png)");
  assert(img.includes('<img src="https://cdn.example.com/a.png"'), `img src 유지 실패 (${img})`);
  assert(img.includes("<figcaption>아기 손 사진</figcaption>"), "alt -> figcaption 실패");
  assert(img.includes('loading="lazy"'), "lazy loading 속성 실패");
  assert(img.includes('style="margin:2em 0"'), "이미지 여백 실패");
  console.log("✅ 이미지 -> figure + img(src 유지) + figcaption + 2em 여백");

  // 2-1) [IMAGE: 설명] placeholder도 같은 여백을 받는다(실제 이미지 자동생성 보류 중 기본 경로)
  const placeholder = convertArticleToHtml("[IMAGE: 아기 손 사진 — 웹 검색]");
  assert(placeholder === '<p style="margin:2em 0">[IMAGE: 아기 손 사진 — 웹 검색]</p>', `placeholder 여백 실패 (${placeholder})`);
  console.log("✅ [IMAGE: 설명] placeholder도 2em 여백");

  // 3) 인라인: strong/em/a
  const inline = convertArticleToHtml("**굵게**와 *이탤릭*, [링크](https://example.com)입니다.");
  assert(inline.includes("<strong>굵게</strong>"), "strong 실패");
  assert(inline.includes("<em>이탤릭</em>"), "em 실패");
  assert(inline.includes('<a href="https://example.com" target="_blank" rel="noopener">링크</a>'), `a 실패 (${inline})`);
  console.log("✅ 인라인 strong/em/a(target=_blank)");

  // 4) 목록(소제목 없이 단독으로 오는 경우)
  const list = convertArticleToHtml("- 하나\n- 둘");
  assert(list.includes("<ul><li>하나</li><li>둘</li></ul>"), `목록 실패 (${list})`);
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
