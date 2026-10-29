// tkmPostStructure.ts 순수 함수 테스트(네트워크 없음). npm run test:tkm-structure
import {
  TKM_AUTHOR_NAME,
  TKM_BYLINE_TEXT,
  applyTkmStructure,
  buildAllGuidesHtml,
  buildJsonLdHtml,
  buildBylineHtml,
  describePost,
  pickTkmRelated,
  sameVisibleText,
  stripTkmBlocks,
  upgradeLegacyHeadings,
  visibleText,
} from "./tkmPostStructure.js";
import type { TkmPost } from "./tkmPostStructure.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const site = "https://tkm.example.com";
// 2026-10 발행본과 같은 모양(renderPublishBlocks 옛 출력): 소제목은 <p style="font-size:19px"><strong>.
const legacy = [
  `<p style="font-size:15px">All you need is one transit card &amp; two taps. Fare is &#8361;1,500.</p>`,
  `<p>&nbsp;</p>`,
  `<figure><img src="https://img.example.com/1.webp" alt="Bus stop" loading="lazy"><figcaption style="font-size:15px">Bus stop</figcaption></figure>`,
  `<p>&nbsp;</p>`,
  `<p style="font-size:19px"><strong>How to Ride a Seoul Bus in 3 Steps</strong></p>`,
  `<p style="font-size:15px">Tap in at the front. <strong>Do not</strong> forget to tap out.</p>`,
  `<p>&nbsp;</p>`,
  `<p style="font-size:19px"><strong>References</strong></p>`,
  `<ul style="font-size:15px"><li><a href="https://world.seoul.go.kr/" target="_blank" rel="noopener">Seoul</a></li></ul>`,
].join("\n");

const posts: TkmPost[] = [
  { url: `${site}/2026/10/seoul-bus.html`, title: "How to Ride a Seoul Bus: Tap In, Ring the Bell", labels: ["Travel & Transit"], published: "2026-10-20T10:00:00+09:00" },
  { url: `${site}/2026/10/t-money.html`, title: "Where to Buy a T-money Card in Korea", labels: ["Travel & Transit"], published: "2026-10-18T10:00:00+09:00" },
  { url: `${site}/2026/10/intercity-bus.html`, title: "Korea Intercity Bus Schedule", labels: ["Travel & Transit"], published: "2026-10-15T10:00:00+09:00" },
  { url: `${site}/2026/10/soju.html`, title: "How to Drink Soju in Korea", labels: ["Food & Dining"], published: "2026-10-16T10:00:00+09:00" },
  { url: `${site}/2026/10/nunchi.html`, title: "What Is Korean Nunchi?", labels: ["Culture & Etiquette"], published: "2026-10-22T10:00:00+09:00" },
  { url: `${site}/2026/10/oldest.html`, title: "Korean Gift Giving Etiquette", labels: ["Culture & Etiquette"], published: "2026-10-07T10:00:00+09:00" },
];
const self = posts[0];

// 1) 옛 소제목 -> h2, 문장 속 굵은 글씨는 그대로
{
  const { html, upgraded } = upgradeLegacyHeadings(legacy);
  assert(upgraded === 2, `소제목 2개 변환 (${upgraded})`);
  assert(html.includes(`<h2 style="font-size:19px">How to Ride a Seoul Bus in 3 Steps</h2>`), "속성 유지한 h2");
  assert(html.includes("<strong>Do not</strong>"), "문장 일부 굵은 글씨는 건드리지 않는다");
  assert(visibleText(html) === visibleText(legacy), "태그 외 글자 손실 0");
  console.log("✅ 옛 소제목 h2 변환 + 글자 보존");
}

// 2) 링크 고르기: 이전 글(체인)·비슷한 글·자기 제외
{
  const related = pickTkmRelated(self, posts, `${site}/p/all-guides.html`);
  assert(related.previous?.url === `${site}/2026/10/t-money.html`, `이전 글은 바로 앞 발행 글 (${related.previous?.url})`);
  assert(related.similar.length === 3 && related.similar.every((link) => link.url !== self.url && link.url !== related.previous?.url), "자기·이전 글 제외 3개");
  assert(related.similar[0].url === `${site}/2026/10/intercity-bus.html`, `제목이 겹치고 라벨이 같은 글이 먼저 (${related.similar[0].url})`);
  const oldest = pickTkmRelated(posts[5], posts, null);
  assert(oldest.previous === null && oldest.similar.length === 3, "가장 오래된 글은 이전 글 없이 비슷한 글만");
  const fresh = pickTkmRelated({ url: null, title: "New Bus Guide", labels: ["Travel & Transit"], published: null }, posts, null);
  assert(fresh.previous?.url === `${site}/2026/10/nunchi.html`, "새 글의 이전 글 = 지금 가장 최신 글");
  console.log("✅ Related 선택 - 체인·유사도·자기 제외");
}

// 3) 적용: References 앞 삽입, 멱등, 글자 보존, JSON-LD
{
  const related = pickTkmRelated(self, posts, `${site}/p/all-guides.html`);
  const jsonLd = {
    url: self.url,
    headline: self.title,
    description: describePost(legacy, null),
    datePublished: self.published,
    dateModified: "2026-10-27T00:00:00Z",
    imageUrl: "https://img.example.com/1.webp",
  };
  const once = applyTkmStructure(legacy, { related, jsonLd });
  assert(once.upgradedHeadings === 2 && once.h2Count === 3 && once.relatedLinks === 5 && once.hasJsonLd, `요약 수치 (${JSON.stringify({ ...once, html: undefined })})`);
  assert(once.html.indexOf("tkm-related") < once.html.indexOf(">References</h2>"), "Related는 References 앞");
  assert(!/<div class="tkm-related">[\s\S]*?<\/div>/.exec(once.html)![0].includes("rel="), "내부 링크에 rel 없음");
  assert(sameVisibleText(legacy, once.html), "우리 블록을 빼면 글자가 같다");
  const twice = applyTkmStructure(once.html, { related, jsonLd });
  assert(twice.html === once.html && twice.upgradedHeadings === 0, "다시 돌려도 같은 결과(멱등)");
  assert(stripTkmBlocks(once.html) === upgradeLegacyHeadings(legacy).html, "블록만 걷으면 h2 변환본과 정확히 같다");
  const ld = JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/.exec(once.html)![1]);
  assert(ld["@type"] === "BlogPosting" && ld.mainEntityOfPage["@id"] === self.url && ld.image[0].includes("1.webp"), "BlogPosting 필드");
  const removed = applyTkmStructure(once.html, { related: null, jsonLd: null, byline: false });
  assert(!removed.html.includes("tkm-related") && !removed.html.includes("ld+json") && !removed.html.includes("tkm-byline"), "null이면 블록을 지운다");
  // References가 없는 글은 끝에 붙고, 그래도 멱등
  const noRefs = legacy.split("\n").slice(0, 6).join("\n");
  const tail = applyTkmStructure(noRefs, { related, jsonLd: null });
  assert(tail.html.endsWith("</div>") && applyTkmStructure(tail.html, { related, jsonLd: null }).html === tail.html, "References 없으면 끝에, 멱등");
  console.log("✅ 적용 - 위치·멱등·글자 보존·JSON-LD");
}

// 3-b) 바이라인(2026-10-30 §A-5): Related 앞·본문 마지막 문단 뒤, 멱등, 첫 문단 추출에 안 걸린다
{
  const related = pickTkmRelated(self, posts, `${site}/p/all-guides.html`);
  const once = applyTkmStructure(legacy, { related, jsonLd: null });
  assert(once.hasByline && once.html.includes(TKM_BYLINE_TEXT), "바이라인 문구가 들어간다");
  const bylineAt = once.html.indexOf(`class="tkm-byline"`);
  const relatedAt = once.html.indexOf(`class="tkm-related"`);
  const refsAt = once.html.indexOf(">References</h2>");
  const bodyAt = once.html.indexOf("Do not</strong> forget to tap out");
  assert(bodyAt < bylineAt && bylineAt < relatedAt && relatedAt < refsAt, `바이라인은 본문 뒤·Related 앞 (${bodyAt}/${bylineAt}/${relatedAt}/${refsAt})`);
  const twice = applyTkmStructure(once.html, { related, jsonLd: null });
  assert(twice.html === once.html, "바이라인도 다시 돌리면 한 번만 남는다(멱등)");
  assert((once.html.match(/tkm-byline/g) ?? []).length === 1, "바이라인 블록은 하나");
  assert(sameVisibleText(legacy, once.html), "바이라인은 글자 비교에서 제외된다");

  // References가 없는 글: 꼬리 묶음 앞에 간격 한 번만
  const noRefs = legacy.split("\n").slice(0, 6).join("\n");
  const tail = applyTkmStructure(noRefs, { related, jsonLd: null });
  assert(tail.html.indexOf("tkm-byline") < tail.html.indexOf("tkm-related"), "References 없어도 바이라인이 Related 앞");
  assert(buildBylineHtml("before").startsWith(`<div class="tkm-byline">\n<p>&nbsp;</p>`), "끝에 붙일 때는 앞 간격 문단");
  assert(applyTkmStructure(tail.html, { related, jsonLd: null }).html === tail.html, "References 없는 글도 멱등");

  // 바이라인만(Related 없음)
  const bylineOnly = applyTkmStructure(legacy, { related: null, jsonLd: null });
  assert(bylineOnly.hasByline && !bylineOnly.html.includes("tkm-related"), "Related 없이 바이라인만도 들어간다");
  assert(bylineOnly.html.indexOf("tkm-byline") < bylineOnly.html.indexOf(">References</h2>"), "바이라인만일 때도 References 앞");
  assert(applyTkmStructure(bylineOnly.html, { related: null, jsonLd: null }).html === bylineOnly.html, "바이라인만도 멱등");

  // 검색 스니펫(JSON-LD description)은 바이라인을 집지 않는다
  assert(describePost(once.html, null).startsWith("All you need is one transit card"), "describePost는 첫 문단 - 바이라인 아님");
  assert(!describePost(once.html, null).includes("Written by Jayden"), "검색 설명에 바이라인이 섞이지 않는다");

  // 끈 경우
  const off = applyTkmStructure(once.html, { related, jsonLd: null, byline: false });
  assert(!off.hasByline && !off.html.includes("tkm-byline"), "byline:false면 기존 바이라인도 걷힌다");
  console.log("✅ 바이라인 - Related 앞·멱등·첫 문단 추출 제외");
}

// 4) JSON-LD 이스케이프·설명 폴백
{
  const html = buildJsonLdHtml({ url: `${site}/x.html`, headline: "A </script> B", description: "d", datePublished: "x", dateModified: "y", imageUrl: null });
  assert(!html.slice(0, -"</script>".length).includes("</script>"), "본문 속 </script>로 일찍 닫히지 않는다");
  assert(describePost(legacy, "  Given   description. ") === "Given description.", "검색 설명이 있으면 그것");
  assert(describePost(legacy, null).startsWith("All you need is one transit card & two taps."), "없으면 첫 문단");
  const ld = JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
  assert(ld.author["@type"] === "Person" && ld.author.name === TKM_AUTHOR_NAME && ld.author.name === "Jayden", `JSON-LD 저자는 사람(Jayden) (${JSON.stringify(ld.author)})`);
  assert(ld.publisher["@type"] === "Organization" && ld.publisher.name === "Korea Plain", "발행자는 Korea Plain 유지");
  assert(ld.publisher.description.includes("by a Korean living in Seoul"), "발행자 설명이 로컬 필자를 밝힌다");
  console.log("✅ JSON-LD 이스케이프·description 폴백·저자 Person");
}

// 5) All Guides 페이지
{
  const html = buildAllGuidesHtml(posts);
  assert(html.indexOf(">Travel &amp; Transit</h2>") < html.indexOf(">Culture &amp; Etiquette</h2>"), "글이 많은 주제가 먼저");
  assert(posts.every((post) => html.includes(`href="${post.url}"`)), "전 글 링크");
  assert(html.indexOf("seoul-bus.html") < html.indexOf("t-money.html"), "주제 안은 최신순");
  assert(html.includes("6 guides in total") && html.includes("(Oct 20, 2026)"), "개수·발행일 표기");
  console.log("✅ All Guides - 주제별·최신순·발행일");
}

console.log("\n✅ 전체 테스트 통과");
