// Korea Plain 리브랜딩 변환 테스트(네트워크 없음). 픽스처는 2026-10-28 공개 페이지에서 본 실제 모양을 줄인 것이다.
import {
  TKM_BRAND_DESCRIPTION,
  TKM_BRAND_NAME,
  TKM_BRAND_TAGLINE,
  buildAllGuidesHtml,
  buildJsonLdHtml,
} from "./tkmPostStructure.js";
import {
  TKM_ABOUT_PATH,
  TKM_ABOUT_TITLE,
  checkNameOnlyChange,
  countFormerName,
  rebrandTkmHtml,
  replaceFormerName,
} from "./tkmRebrand.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

const site = "https://thekoreamanual.blogspot.com";
const oldJsonLd =
  `<script type="application/ld+json" class="tkm-jsonld">{"@context":"https://schema.org","@type":"BlogPosting","headline":"How to Ride a Seoul Bus",` +
  `"description":"Tap in, ring the bell, tap out.","datePublished":"2026-10-20T01:00:00.000Z","dateModified":"2026-10-27T11:08:57.017Z",` +
  `"author":{"@type":"Organization","name":"The Korea Manual","url":"${site}/"},"publisher":{"@type":"Organization","name":"The Korea Manual","url":"${site}/"},` +
  `"image":["https://korea-manual-images-2026.pages.dev/x/1.webp"],"mainEntityOfPage":{"@type":"WebPage","@id":"${site}/2026/10/bus.html"},"url":"${site}/2026/10/bus.html"}</script>`;
const postHtml = [
  `<p style="font-size:15px">Tap your card when you board. <a href="${site}/p/about-korea-manual.html">About</a></p>`,
  `<div class="tkm-related"><h2 style="font-size:19px">Related Guides</h2><ul><li><a href="${site}/2026/10/t-money.html">T-money</a></li></ul></div>`,
  oldJsonLd,
].join("\n");

// 1) 새 발행 경로: buildJsonLdHtml이 새 이름 + 태그라인·설명(발행자)으로 나간다.
{
  const html = buildJsonLdHtml({ url: `${site}/2026/10/new.html`, headline: "New", description: "d", datePublished: "x", dateModified: "y", imageUrl: null });
  const data = JSON.parse(/>(.*)<\/script>/.exec(html)![1]);
  assert(data.author.name === TKM_BRAND_NAME && data.publisher.name === TKM_BRAND_NAME, "새 JSON-LD 저자·발행자 = Korea Plain");
  assert(data.publisher.slogan === TKM_BRAND_TAGLINE && data.publisher.description === TKM_BRAND_DESCRIPTION, "발행자에 태그라인·설명");
  assert(data.author.slogan === undefined, "저자에는 태그라인을 중복하지 않는다");
  assert(!html.includes("Korea Manual"), "새 JSON-LD에 옛 이름 없음");
  assert(/^[\x00-\x7e]*$/.test(html) && html.includes("\\u2014"), "JSON-LD는 ASCII만(—는 \\u2014) - Blogger 엔티티 변환 방지");
  assert(buildAllGuidesHtml([{ url: `${site}/a.html`, title: "A", labels: ["X"], published: "2026-10-01" }]).includes("Every guide on Korea Plain,"), "All Guides 문구 새 이름");
}

// 2) 글: JSON-LD author/publisher만 바뀌고 나머지(주소 슬러그 포함)는 글자 하나 안 바뀐다.
{
  const result = rebrandTkmHtml({ path: "/2026/10/bus.html", title: "How to Ride a Seoul Bus", html: postHtml });
  assert(result.changed && result.jsonLdBlocks === 1 && result.textReplacements === 0 && !result.titleChanged, "글: JSON-LD 1블록만 변경");
  assert(result.check.ok, `글: 이름 치환뿐 (${result.check.ok ? "" : result.check.reason})`);
  assert(result.html.includes("p/about-korea-manual.html") && result.html.includes("korea-manual-images-2026.pages.dev"), "주소·이미지 호스트는 그대로");
  assert(result.html.includes(`"dateModified":"2026-10-27T11:08:57.017Z"`), "dateModified 그대로");
  assert(!result.html.includes("The Korea Manual"), "글: 옛 이름 0");
  const withDash = rebrandTkmHtml({ path: "/x", title: "x", html: oldJsonLd.replace("Tap in, ring", "Tap in – ring ₩1,500") });
  const rawDash = result.html.replace("\\u2014", "\u2014");
  assert(rebrandTkmHtml({ path: "/x", title: "x", html: rawDash }).html === result.html, "이름이 새 것이어도 날것 비ASCII는 다시 이스케이프");
  assert(withDash.check.ok && withDash.html.includes("Tap in \\u2013 ring \\u20a91,500"), "기존 칸의 비ASCII도 이스케이프(값은 같아 검증 통과)");
  const again = rebrandTkmHtml({ path: "/2026/10/bus.html", title: "How to Ride a Seoul Bus", html: result.html });
  assert(!again.changed, "글: 다시 돌리면 변경 없음(멱등)");
}

// 3) 일반 페이지(Disclaimer): 본문 치환, 제목 그대로.
{
  const html = `<p>The Korea Manual provides general information.</p><p>The Korea Manual and its operator are not liable.</p>`;
  const result = rebrandTkmHtml({ path: "/p/disclaimer.html", title: "Disclaimer", html });
  assert(result.textReplacements === 2 && result.html === `<p>Korea Plain provides general information.</p><p>Korea Plain and its operator are not liable.</p>`, "Disclaimer 2회 치환");
  assert(result.check.ok && !result.titleChanged, "Disclaimer 이름 치환뿐, 제목 그대로");
}

// 4) About: 제목 교체 + 태그라인 + formerly, 다시 돌려도 그대로.
{
  const html = `<p>&nbsp;The Korea Manual is a practical, English-language guide to using everyday life in Korea.</p><p><br /></p><p>The Korea Manual is independent.</p>`;
  const result = rebrandTkmHtml({ path: TKM_ABOUT_PATH, title: "About The Korea Manual", html });
  assert(result.title === TKM_ABOUT_TITLE && TKM_ABOUT_TITLE === "About Korea Plain", "About 제목");
  assert(result.html.startsWith(`<p><b>Korea, in plain English.</b></p><p>&nbsp;Korea Plain (formerly The Korea Manual) is a practical`), `About 첫머리 (${result.html.slice(0, 120)})`);
  assert(result.html.includes("<p>Korea Plain is independent.</p>"), "About 나머지 언급 치환");
  assert(result.check.ok, `About: 이름 치환 + 허용 삽입뿐 (${result.check.ok ? "" : result.check.reason})`);
  assert(countFormerName(result.html) === 0, "About: formerly 말고 옛 이름 0");
  const again = rebrandTkmHtml({ path: TKM_ABOUT_PATH, title: result.title, html: result.html });
  assert(!again.changed && again.check.ok, "About: 다시 돌리면 변경 없음(멱등)");
}

// 5) 검증이 이름 외 변경을 잡는다.
{
  const tampered = postHtml.replace("Tap your card", "Tap your phone").replace(/The Korea Manual/g, "Korea Plain");
  const check = checkNameOnlyChange(postHtml, tampered);
  assert(!check.ok, "본문 글자가 바뀌면 거부");
  const dateChanged = rebrandTkmHtml({ path: "/x", title: "x", html: postHtml }).html.replace("2026-10-27T11:08:57.017Z", "2026-10-28T00:00:00.000Z");
  assert(!checkNameOnlyChange(postHtml, dateChanged).ok, "JSON-LD 이름 외 칸이 바뀌면 거부");
}

// 6) 치환 규칙: 소문자 주소·슬러그·스크립트 안은 건드리지 않는다. "the Korea Manual"도 잡는다.
{
  assert(replaceFormerName("on the Korea Manual site") === "on Korea Plain site", "소문자 the 포함 치환");
  assert(replaceFormerName("thekoreamanual.blogspot.com /p/about-korea-manual.html") === "thekoreamanual.blogspot.com /p/about-korea-manual.html", "주소·슬러그 그대로");
  assert(replaceFormerName(`<script>var t="The Korea Manual";</script>`) === `<script>var t="The Korea Manual";</script>`, "스크립트 안 그대로");
  assert(replaceFormerName("Korea Plain (formerly The Korea Manual)") === "Korea Plain (formerly The Korea Manual)", "formerly 표기는 남긴다");
}

console.log("\n모든 Korea Plain 리브랜딩 테스트 통과");
