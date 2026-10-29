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

  // 주소 안의 짝 맞는 괄호는 URL의 일부다(위키백과 문서명). 뒤따르는 짝 없는 `)`는 링크의 끝이다.
  const paren = convertArticleToHtml("- [룩백 (2026년 영화) - 위키백과](https://ko.wikipedia.org/wiki/룩백_(2026년_영화))");
  assert(paren.includes('href="https://ko.wikipedia.org/wiki/룩백_(2026년_영화)"'), `괄호 URL 실패 (${paren})`);
  const plain = convertArticleToHtml("[가](https://a.com/x) 그리고 (참고: [나](https://b.com/y))");
  assert(plain.includes('href="https://a.com/x"') && plain.includes('href="https://b.com/y"'), `일반 URL 회귀 (${plain})`);
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

  // 7) 로컬 콜아웃 박스(2026-10-30, 사용설명서 트랙 전용 - 개정안 §B-4·§D-2)
  const layers = [
    "**Local note: what Koreans actually do**",
    "Most people in Korea tap the card on the back-door reader.",
    "",
    "**Common misreading**",
    "Visitors assume the front door is the only exit.",
    "",
    "**Words you will see**",
    "- 보행자 작동신호기 (pedestrian push-button signal) — on the pole",
    "- 음식물 (food waste) — the button on the bin screen",
    "",
    "**Next steps**",
    "Tap out before you leave.",
  ].join("\n");

  const callouts = convertArticleToHtml(layers, { semanticHeadings: true, localCallouts: true });
  assert(callouts.includes('<div class="kp-local" data-kp-label="Local note: what Koreans actually do">'), `kp-local 박스 실패 (${callouts})`);
  assert(callouts.includes('<div class="kp-misread" data-kp-label="Common misreading">'), "kp-misread 박스 실패");
  assert(callouts.includes('<div class="kp-words" data-kp-label="Words you will see">'), "kp-words 박스 실패");
  // 소제목 텍스트는 박스 안에 넣지 않는다 - §B-4 CSS의 ::before가 제목을 그린다.
  assert(!callouts.includes("<strong>Local note"), "콜아웃 소제목이 박스 안에 남았다(::before와 중복)");
  assert(!callouts.includes("<h2 style=\"font-size:19px\">Common misreading</h2>"), "콜아웃 소제목이 h2로 남았다");
  // kp-words 안의 한글만 kp-ko로 감싼다.
  assert(callouts.includes('<span class="kp-ko">보행자 작동신호기</span>'), `kp-ko 실패 (${callouts})`);
  assert(callouts.includes('<span class="kp-ko">음식물</span>'), "kp-ko 두 번째 토큰 실패");
  // 콜아웃이 아닌 소제목은 그대로 h2다.
  assert(callouts.includes("<h2 style=\"font-size:19px\">Next steps</h2>"), `일반 소제목 회귀 (${callouts})`);
  console.log("✅ 로컬 콜아웃 박스(kp-local/kp-misread/kp-words) + kp-ko");

  // 8) 옵션을 끄면 출력이 기존과 한 글자도 다르지 않다(다른 트랙·네이버·티스토리 불변 보장)
  const withoutCallouts = convertArticleToHtml(layers, { semanticHeadings: true });
  assert(!withoutCallouts.includes("kp-local") && !withoutCallouts.includes("kp-ko"), "옵션 꺼짐인데 콜아웃이 나왔다");
  assert(withoutCallouts.includes("<h2 style=\"font-size:19px\">Local note: what Koreans actually do</h2>"), `옵션 꺼짐 회귀 (${withoutCallouts})`);
  const plainTrack = convertArticleToHtml(layers);
  assert(!plainTrack.includes("kp-local") && plainTrack.includes("<strong>Local note: what Koreans actually do</strong>"), "기본 호출 회귀");
  console.log("✅ localCallouts 꺼짐 = 기존 출력 그대로");

  // 9) 소제목과 문단 사이에 빈 줄이 하나 끼어도 박스가 문단을 끌어온다. 재료가 없으면 빈 박스를 만들지 않는다.
  const gapped = convertArticleToHtml("**Common misreading**\n\nVisitors assume the front door is the only exit.", { localCallouts: true });
  assert(gapped.includes('<div class="kp-misread"') && gapped.includes("Visitors assume"), `빈 줄 끼인 콜아웃 실패 (${gapped})`);
  const empty = convertArticleToHtml("**Common misreading**\n\n**Next steps**\nTap out.", { localCallouts: true });
  assert(!empty.includes("kp-misread"), `재료 없는 콜아웃이 빈 박스로 나왔다 (${empty})`);
  console.log("✅ 빈 줄 끼인 문단 흡수 / 재료 없으면 박스 없음");

  console.log("\n✅ 전체 테스트 통과");
}

main();
