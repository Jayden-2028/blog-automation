import { convertArticleToTistoryHtml } from "./convertArticleToTistoryHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const md = "**소제목**\n문단 *강조* [링크](https://a.b/c)\n\n![캡션](https://img.example/x.png)\n\n- 하나\n- 둘";
const { html, images } = convertArticleToTistoryHtml(md);
assert(images.length === 1 && images[0].marker === "⟦IMG-1⟧" && images[0].alt === "캡션", `이미지 추출 (${JSON.stringify(images)})`);
assert(html.includes("⟦IMG-1⟧") && !html.includes("<img"), "본문에는 표식만");
assert(html.includes("<strong>") && html.includes("<em>"), "strong/em");
assert(/<a [^>]*target="_blank"/.test(html), "링크는 새 탭");
assert(html.includes("<li>하나</li>") || html.includes("하나"), "목록 유지");
console.log("✅ convertArticleToTistoryHtml 통과");
