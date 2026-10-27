// articles.content 옛(404) 티스토리 주소 치환 테스트(2026-10-28). 실행: npm run test:tistory-fix-links
// DB·네트워크를 쓰지 않는다 - 픽스처 18쌍으로 실제 본문 형태(마크다운 "함께 보면 좋은 글")를 흉내 낸다.
import { countDeadLinksInContent, loadDeadLinkPairs, replaceDeadLinksInContent } from "./tistoryDeadLinks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const HOST = "wooahpapa.tistory.com";
const pairs = loadDeadLinkPairs();
const pair = (id: number) => pairs.find((p) => p.publicationId === id)!;
assert(pairs.length === 18, `픽스처 18쌍 (${pairs.length})`);

const related = (links: Array<{ title: string; url: string }>) =>
  `본문 첫 문단.\n\n**함께 보면 좋은 글**\n${links.map((l) => `- [${l.title}](${l.url})`).join("\n")}\n\n**참고 자료**\n- [기사](https://news.example/a)\n`;

// 1) 21편 흉내 - 2026-10-27 dry-run 목록의 (article → 옛 링크 pub id). 693만 2개.
const AUDIT_HITS: Record<number, number[]> = {
  752: [298], 741: [333], 729: [333], 723: [380], 715: [269], 701: [354], 693: [319, 298], 664: [282], 660: [319], 646: [257],
  642: [255], 631: [269], 605: [245], 583: [298], 578: [298], 561: [298], 537: [255], 530: [282], 499: [269], 490: [256], 457: [244],
};
{
  assert(Object.keys(AUDIT_HITS).length === 21, "21편");
  let total = 0;
  for (const [articleId, pubIds] of Object.entries(AUDIT_HITS)) {
    const live = { title: "멀쩡한 글", url: "https://wooahpapa.tistory.com/entry/%EB%A9%80%EC%A9%A1%ED%95%9C-%EA%B8%80" };
    const content = related([...pubIds.map((id) => ({ title: `글 ${id}`, url: pair(id).from })), live]);
    const { content: next, fixes } = replaceDeadLinksInContent(content, pairs, HOST);
    const count = fixes.reduce((sum, fix) => sum + fix.count, 0);
    assert(count === pubIds.length, `article ${articleId}: ${pubIds.length}개 치환 (${count})`);
    for (const id of pubIds) {
      assert(!next.includes(`(${pair(id).from})`), `article ${articleId}: 옛 주소 ${id} 제거`);
      assert(next.includes(`(${pair(id).to})`), `article ${articleId}: 새 주소 ${id} 삽입`);
    }
    assert(next.includes(live.url) && next.includes("https://news.example/a"), `article ${articleId}: 다른 링크 보존`);
    assert(next.replace(/\]\([^)]*\)/g, "") === content.replace(/\]\([^)]*\)/g, ""), `article ${articleId}: 링크 주소 밖 글자는 그대로`);
    // 멱등 - 두 번째는 0건, 결과 동일.
    const again = replaceDeadLinksInContent(next, pairs, HOST);
    assert(again.fixes.length === 0 && again.content === next, `article ${articleId}: 재실행 변경 없음`);
    total += count;
  }
  assert(total === 22, `링크 합계 22개 (${total})`);
  console.log("✅ replaceDeadLinksInContent - 21편(693은 2개) 치환, 다른 링크·본문 보존, 멱등");
}

// 2) 특수 형태 - 날것 ' (257), 날것 ? (253), 30%25 (245), 풀린 한글 저장, http
{
  for (const id of [257, 253, 245]) {
    const content = related([{ title: `글 ${id}`, url: pair(id).from }]);
    const { content: next, fixes } = replaceDeadLinksInContent(content, pairs, HOST);
    assert(fixes.length === 1 && next.includes(`(${pair(id).to})`), `id ${id} 특수문자 주소 치환`);
  }
  const p380 = pair(380);
  const decoded = related([{ title: "풀린 한글", url: decodeURI(p380.from) }]);
  assert(replaceDeadLinksInContent(decoded, pairs, HOST).content.includes(`(${p380.to})`), "풀린 한글로 저장된 옛 주소도 치환");
  const http = related([{ title: "http", url: p380.from.replace("https://", "http://") }]);
  assert(countDeadLinksInContent(http, pairs, HOST) === 1, "http 변형도 센다");
  // 옛 주소 뒤에 글자가 더 붙은 다른 주소는 건드리지 않는다.
  const longer = related([{ title: "다른 글", url: `${p380.from}-2` }]);
  assert(countDeadLinksInContent(longer, pairs, HOST) === 0, "접두만 같은 주소는 제외");
  // HTML 본문(href 속성)에서도 동작한다.
  const html = `<p><a href="${p380.from}">x</a></p>`;
  assert(replaceDeadLinksInContent(html, pairs, HOST).content === `<p><a href="${p380.to}">x</a></p>`, "HTML href 치환");
  console.log("✅ replaceDeadLinksInContent - 날것 '·?·%, 풀린 한글, http, 접두 일치 제외, HTML");
}

console.log("\n✅ testTistoryDeadLinks 전부 통과");
