// convertArticleToHtml 테스트. 순수 변환 함수만 검증한다(네트워크/DB 없음).
import { convertArticleToHtml } from "./convertArticleToHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ convertArticleToHtml 테스트 시작\n");

  // 1) ## -> h2, ### -> h3 (headingBaseLevel 기본 2)
  const headings = convertArticleToHtml("## 큰 소제목\n\n본문\n\n### 작은 소제목\n\n또 본문");
  assert(headings.includes("<h2>큰 소제목</h2>"), `h2 변환 실패 (${headings})`);
  assert(headings.includes("<h3>작은 소제목</h3>"), `h3 변환 실패 (${headings})`);
  console.log("✅ ## -> h2, ### -> h3");

  // 2) 이미지 -> figure/img/figcaption, src 유지(네이버 변환기와 달리 걷어내지 않는다)
  const img = convertArticleToHtml("![아기 손 사진](https://cdn.example.com/a.png)");
  assert(img.includes('<img src="https://cdn.example.com/a.png"'), `img src 유지 실패 (${img})`);
  assert(img.includes("<figcaption>아기 손 사진</figcaption>"), "alt -> figcaption 실패");
  assert(img.includes('loading="lazy"'), "lazy loading 속성 실패");
  console.log("✅ 이미지 -> figure + img(src 유지) + figcaption");

  // 3) 인라인: strong/em/a
  const inline = convertArticleToHtml("**굵게**와 *이탤릭*, [링크](https://example.com)입니다.");
  assert(inline.includes("<strong>굵게</strong>"), "strong 실패");
  assert(inline.includes("<em>이탤릭</em>"), "em 실패");
  assert(inline.includes('<a href="https://example.com" target="_blank" rel="noopener">링크</a>'), `a 실패 (${inline})`);
  console.log("✅ 인라인 strong/em/a(target=_blank)");

  // 4) 목록
  const list = convertArticleToHtml("- 하나\n- 둘");
  assert(list.includes("<ul><li>하나</li><li>둘</li></ul>"), `목록 실패 (${list})`);
  console.log("✅ 목록 -> ul/li");

  // 5) HTML 이스케이프(본문에 < > & 가 있어도 안전)
  const escaped = convertArticleToHtml("a < b && c > d 인 경우");
  assert(escaped.includes("a &lt; b &amp;&amp; c &gt; d"), `이스케이프 실패 (${escaped})`);
  console.log("✅ 특수문자 이스케이프");

  // 6) FAQ/요약 소제목도 그냥 h2로(별도 처리 없음)
  const faq = convertArticleToHtml("## 자주 묻는 질문\n\n**Q. 언제?**\n\n9월입니다.\n\n## 요약\n\n핵심 재진술.");
  assert(faq.includes("<h2>자주 묻는 질문</h2>") && faq.includes("<h2>요약</h2>"), "FAQ/요약 h2 실패");
  console.log("✅ FAQ/요약 소제목 h2");

  console.log("\n✅ 전체 테스트 통과");
}

main();
