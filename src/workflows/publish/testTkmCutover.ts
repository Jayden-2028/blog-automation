// Korea Plain 맞춤 도메인 전환(2026-10-28) 순수 함수 테스트(네트워크·DB 없음). npm run test:tkm-cutover
import { KSCENE_PUBLIC_ORIGIN, isTkmUrl, normalizeTkmUrl, rewriteTkmLegacyUrls, tkmUrlAliases } from "../../config/publishTargets.js";
import { changedTopLevel, fieldOf, rewriteLegacyUrlsDeep } from "./tkmCutover.js";
import { applyTkmStructure, buildAllGuidesHtml, buildJsonLdHtml, normalizePostUrl, pickTkmRelated, sameVisibleText } from "./tkmPostStructure.js";
import type { TkmPost } from "./tkmPostStructure.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NEW = "https://www.koreaplain.com";
const OLD = "https://thekoreamanual.blogspot.com";

// 1) 기본값·호스트 교체
{
  assert(KSCENE_PUBLIC_ORIGIN === NEW, `기본 공개 주소 (${KSCENE_PUBLIC_ORIGIN})`);
  assert(normalizeTkmUrl(`${OLD}/2026/10/a.html?m=1#x`) === `${NEW}/2026/10/a.html?m=1#x`, "경로·쿼리·해시 보존");
  assert(normalizeTkmUrl("http://thekoreamanual.blogspot.com/p/about.html") === `${NEW}/p/about.html`, "http 옛 주소도");
  assert(normalizeTkmUrl("http://www.koreaplain.com/x.html") === `${NEW}/x.html`, "http 새 주소는 https로");
  assert(normalizeTkmUrl("https://koreaplain.com/x.html") === `${NEW}/x.html`, "apex는 www로");
  assert(normalizeTkmUrl(`${NEW}/x.html`) === `${NEW}/x.html`, "이미 공개 주소면 그대로");
  assert(normalizeTkmUrl("https://wooahpapa.tistory.com/12") === "https://wooahpapa.tistory.com/12", "다른 블로그는 그대로");
  assert(normalizeTkmUrl("https://www.blogger.com/blog/post/edit/1/2") === "https://www.blogger.com/blog/post/edit/1/2", "초안 편집 URL 그대로");
  assert(normalizeTkmUrl("not a url") === "not a url" && normalizeTkmUrl("") === "", "URL이 아니면 그대로");
  assert(normalizeTkmUrl(`${OLD}/a.html`, "https://tkm.example.com") === "https://tkm.example.com/a.html", "origin 주입(KSCENE_PUBLIC_ORIGIN 덮어쓰기)");
  assert(isTkmUrl(`${OLD}/a`) && isTkmUrl(`${NEW}/a`) && !isTkmUrl("https://x.blogspot.com/a"), "TKM 판정");
  console.log("✅ normalizeTkmUrl - 호스트만 교체·경로 보존·타 블로그 무시");
}

// 2) 별칭(분석 매칭)
{
  const aliases = tkmUrlAliases(`${OLD}/2026/10/a.html`);
  assert(aliases.includes(`${OLD}/2026/10/a.html`) && aliases.includes(`${NEW}/2026/10/a.html`) && aliases.length === 2, `옛→둘 (${aliases.join(",")})`);
  const reverse = tkmUrlAliases(`${NEW}/2026/10/a.html`);
  assert(reverse.includes(`${OLD}/2026/10/a.html`) && reverse.length === 2, "새→옛 포함");
  assert(tkmUrlAliases("https://wooahpapa.tistory.com/12").join("|") === "https://wooahpapa.tistory.com/12", "타 블로그는 자기 자신만");
  console.log("✅ tkmUrlAliases - 두 호스트를 같은 글로");
}

// 3) 본문 절대 URL 치환
{
  const html = `<a href="${OLD}/2026/10/a.html">A</a> <a href="//thekoreamanual.blogspot.com/p/b.html">B</a> thekoreamanual.blogspot.com 언급 <a href="https://thekoreamanual.blogspot.com.evil.com/x">X</a> <img src="https://1.bp.blogspot.com/z.png">`;
  const { text, count } = rewriteTkmLegacyUrls(html);
  assert(count === 2, `절대 URL 2개만 (${count})`);
  assert(text.includes(`href="${NEW}/2026/10/a.html"`) && text.includes(`href="${NEW}/p/b.html"`), "https·// 모두 공개 주소로");
  assert(text.includes("thekoreamanual.blogspot.com 언급"), "스킴 없는 언급은 그대로");
  assert(text.includes("thekoreamanual.blogspot.com.evil.com"), "호스트 접미 우연 일치는 제외");
  assert(text.includes("1.bp.blogspot.com"), "다른 blogspot 호스트(이미지) 그대로");
  assert(rewriteTkmLegacyUrls(text).count === 0, "멱등");
  console.log("✅ rewriteTkmLegacyUrls - 절대 URL만·멱등");
}

// 4) metadata 깊은 치환
{
  const metadata = {
    track: "kscene",
    bingSubmit: { at: "t", urls: [`${OLD}/a.html`, `${OLD}/p/all-guides.html`], ok: true },
    tkmStructure: { allGuidesUrl: `${OLD}/p/all-guides.html`, h2: 5 },
    images: [{ url: "https://korea-manual-images-2026.pages.dev/1.webp" }],
  };
  const { value, hits } = rewriteLegacyUrlsDeep(metadata);
  const next = value as typeof metadata;
  assert(hits.length === 3, `문자열 3개 (${hits.length})`);
  assert(hits.map((hit) => fieldOf(hit.path)).sort().join("|") === "bingSubmit.urls[]|bingSubmit.urls[]|tkmStructure.allGuidesUrl", "경로 기록");
  assert(next.bingSubmit.urls[0] === `${NEW}/a.html` && next.tkmStructure.allGuidesUrl === `${NEW}/p/all-guides.html`, "값 치환");
  assert(metadata.bingSubmit.urls[0] === `${OLD}/a.html`, "원본 불변");
  assert(next.images === metadata.images, "안 바뀐 가지는 같은 참조");
  const patch = changedTopLevel(metadata, next as Record<string, unknown>);
  assert(Object.keys(patch).sort().join("|") === "bingSubmit|tkmStructure", "바뀐 최상위 키만 patch");
  assert(rewriteLegacyUrlsDeep({ a: 1, b: null, c: ["x"] }).hits.length === 0, "옛 주소 없으면 hits 0");
  console.log("✅ rewriteLegacyUrlsDeep - 경로·값·최상위 patch");
}

// 5) 구조 보강이 옛 주소를 받아도 공개 주소로 링크한다
{
  const posts: TkmPost[] = [
    { url: `${OLD}/2026/10/a.html`, title: "Seoul Bus Guide", labels: ["Travel"], published: "2026-10-20T00:00:00Z" },
    { url: `${OLD}/2026/10/b.html`, title: "T-money Card Guide", labels: ["Travel"], published: "2026-10-10T00:00:00Z" },
    { url: `${NEW}/2026/10/c.html`, title: "Subway Card Tips", labels: ["Travel"], published: "2026-10-05T00:00:00Z" },
  ];
  const related = pickTkmRelated({ url: `${NEW}/2026/10/a.html`, title: "Seoul Bus Guide", labels: ["Travel"], published: "2026-10-20T00:00:00Z" }, posts, `${OLD}/p/all-guides.html`);
  assert(related.previous?.url === `${NEW}/2026/10/b.html`, "이전 글 링크는 공개 주소");
  assert(!related.similar.some((link) => link.url.includes("/a.html")), "자기 글은 호스트가 달라도 제외");
  assert(related.allGuidesUrl === `${NEW}/p/all-guides.html`, "허브 주소도 공개 주소");
  assert(normalizePostUrl(`${OLD}/2026/10/a.html?m=1`) === normalizePostUrl(`${NEW}/2026/10/a.html`), "비교 키는 호스트 무관");

  const hub = buildAllGuidesHtml(posts);
  assert(!hub.includes("blogspot") && hub.includes(`href="${NEW}/2026/10/a.html"`), "All Guides 링크 공개 주소");
  const jsonLd = buildJsonLdHtml({ url: `${OLD}/2026/10/a.html`, headline: "h", description: "d", datePublished: "x", dateModified: "y", imageUrl: null });
  assert(!jsonLd.includes("blogspot") && jsonLd.includes(`"url":"${NEW}/2026/10/a.html"`) && jsonLd.includes(`"url":"${NEW}/"`), "JSON-LD 글·발행자 주소");

  // --rewrite-host 흐름: 옛 Related 블록이 든 본문 → 옛 주소 치환 → 블록 갈아 끼우기. 글자 검증은 치환본 기준.
  const before = `<p style="font-size:15px">Body <a href="${OLD}/p/about.html">About</a></p>\n<div class="tkm-related"><h2 style="font-size:19px">Related Guides</h2><ul><li><a href="${OLD}/2026/10/b.html">T-money Card Guide</a></li></ul></div>`;
  const source = rewriteTkmLegacyUrls(before).text;
  const result = applyTkmStructure(source, { related, jsonLd: null });
  assert(!result.html.includes("blogspot"), "결과에 옛 주소 없음");
  assert(sameVisibleText(source, result.html), "읽히는 글자 그대로");
  assert(applyTkmStructure(result.html, { related, jsonLd: null }).html === result.html, "다시 돌려도 같다(멱등)");
  console.log("✅ 구조 보강 - Related·All Guides·JSON-LD 모두 공개 주소, 멱등");
}

console.log("\n✅ 전체 테스트 통과");
