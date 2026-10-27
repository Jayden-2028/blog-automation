// 발행 후 수정(editPost) 순수 함수 테스트(2026-10-28). 실행: npm run test:tistory-edit
// 네트워크·브라우저를 쓰지 않는다.
import { readFileSync } from "node:fs";

import {
  checkEditInvariants,
  countLinksTo,
  extractHrefs,
  extractPageTitle,
  extractTistoryPostId,
  hrefKey,
  planHrefReplacements,
  snapshotFromRaw,
  tistoryEditUrl,
  type RawEditorState,
} from "./tistoryPostEdit.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const HOST = "wooahpapa.tistory.com";
const pairs = (
  JSON.parse(readFileSync(new URL("./fixtures/tistoryUrlAudit-2026-10-27.json", import.meta.url), "utf-8")) as Array<{ id: number; stored: string; fix: string }>
).map((row) => ({ id: row.id, from: row.stored, to: row.fix }));
const pair = (id: number) => pairs.find((p) => p.id === id)!;

// 1) 글 ID 추출 - 세 가지 형태 + 모호한 경우
{
  const a = extractTistoryPostId(`<div class="article" data-entry-id="120"></div><div data-entry-id="120"></div>`);
  assert(a?.id === 120 && a.source === "data-entry-id", `data-entry-id (${JSON.stringify(a)})`);
  const b = extractTistoryPostId(`<script>window.T.entryInfo = {"entryId":345,"categoryId":1}</script>`);
  assert(b?.id === 345 && b.source === "entryId", `"entryId":N (${JSON.stringify(b)})`);
  const c = extractTistoryPostId(
    `<a href="/77#comment">댓글</a><a href="https://wooahpapa.tistory.com/77">이 글</a><a href="/76">이전 글</a><a href="/77?category=1">x</a>`
  );
  assert(c?.id === 77 && c.source === "link", `/<N> 링크 최다 (${JSON.stringify(c)})`);
  // data-entry-id가 둘로 갈리면(목록 페이지) 다음 규칙으로 넘어간다.
  const d = extractTistoryPostId(`<div data-entry-id="1"></div><div data-entry-id="2"></div><script>{"entryId":2}</script>`);
  assert(d?.id === 2 && d.source === "entryId", `data-entry-id 모호 → entryId (${JSON.stringify(d)})`);
  assert(extractTistoryPostId(`<a href="/5">a</a><a href="/6">b</a>`) === null, "링크 동률이면 null");
  assert(extractTistoryPostId("<html></html>") === null, "없으면 null");
  assert(tistoryEditUrl("wooahpapa", 120) === "https://wooahpapa.tistory.com/manage/newpost/120?type=post", "수정 화면 주소");
  assert(extractPageTitle(`<meta property="og:title" content="인멸&amp;middot;도망 우려"/>`) === "인멸·도망 우려", "og:title 엔티티");
  console.log("✅ extractTistoryPostId - data-entry-id / entryId / /<N> 링크, 모호하면 다음 규칙");
}

// 2) href 키 - 인코딩 변형을 같은 주소로
{
  const p397 = pair(397);
  const decoded = decodeURI(p397.from);
  assert(hrefKey(p397.from) === hrefKey(decoded), "퍼센트 인코딩 = 풀린 한글");
  assert(hrefKey(p397.from) === hrefKey(p397.from.replace("https://", "http://") + "/"), "http·끝 슬래시 무시");
  assert(hrefKey(p397.from) === hrefKey(`${p397.from}#comment`), "#조각 무시");
  assert(hrefKey(p397.from.replace(/^https:\/\/[^/]+/, ""), HOST) === hrefKey(p397.from), "상대 경로 + host");
  assert(hrefKey(p397.from) !== hrefKey(p397.to), "옛≠새");
  // 날것 퍼센트(id 245: 30%25)와 날것 물음표(id 253)도 죽지 않고 같게 본다.
  const p245 = pair(245);
  assert(hrefKey(p245.from) === hrefKey(p245.from.replace("30%25", "30%")), "%25 = 날것 %");
  const p253 = pair(253);
  assert(hrefKey(p253.from) === hrefKey(p253.from.replace("?", "%3F")), "날것 ? = %3F");
  assert(hrefKey(p253.from.replace("https://wooahpapa", "https://WOOAHPAPA")) === hrefKey(p253.from), "호스트 대소문자");
  console.log("✅ hrefKey - 인코딩·프로토콜·슬래시·조각·상대경로 변형 흡수");
}

// 3) 치환 계획 - 정확 일치 + 변형만, 이미 새 주소·다른 글은 그대로
{
  const p298 = pair(298);
  const p319 = pair(319);
  const hrefs = [
    "https://www.example.com/news/1",
    p298.from,
    decodeURI(p319.from), // 풀린 한글로 저장된 경우
    p298.to, // 이미 새 주소
    p298.from.slice(0, -10), // 앞부분만 같은 다른 주소
  ];
  const plan = planHrefReplacements(hrefs, pairs, HOST);
  assert(plan.length === 2, `2건만 계획 (${plan.length})`);
  assert(plan[0].index === 1 && plan[0].from === p298.from && plan[0].to === p298.to, "정확 일치");
  assert(plan[1].index === 2 && plan[1].to === p319.to, "디코딩 변형");
  assert(planHrefReplacements([p298.to], pairs, HOST).length === 0, "이미 바뀐 글은 계획 0건(멱등)");
  const html = `<p><a href="${p298.from}">a</a> <a href='${p319.to}'>b</a> <a class="x" href="${p298.from.replace(/,/g, "&#44;")}">c</a></p>`;
  assert(extractHrefs(html).length === 3, "extractHrefs - 큰·작은따옴표");
  assert(countLinksTo(html, [p298.from], HOST) === 2, "엔티티로 쓴 같은 주소도 센다");
  console.log("✅ planHrefReplacements - 옛 주소(인코딩 변형 포함)만, 이미 새 주소·접두 일치는 제외");
}

// 4) 불변 검증
{
  const p298 = pair(298);
  const text = "본문 텍스트 ".repeat(200);
  const hrefs = ["https://news.example/1", p298.from, "https://news.example/2"];
  const content = (list: string[]) => `<p>${text}</p>` + list.map((h, i) => `<a href="${h}">링크${i}</a>`).join("") + `<img src="x.png">`;
  const raw = (over: Partial<RawEditorState> = {}): RawEditorState => ({ text, images: 1, hrefs, content: content(hrefs), ...over });
  const before = snapshotFromRaw(raw());
  const plan = planHrefReplacements(hrefs, pairs, HOST);
  const goodHrefs = hrefs.map((h, i) => (i === 1 ? p298.to : h));

  const ok = checkEditInvariants(before, snapshotFromRaw(raw({ hrefs: goodHrefs, content: content(goodHrefs) })), plan, HOST);
  assert(ok.ok && ok.changed.length === 1 && ok.changed[0].to === p298.to, `정상 변경 통과 (${JSON.stringify(ok)})`);

  const textChanged = checkEditInvariants(before, snapshotFromRaw(raw({ text: text + "!", hrefs: goodHrefs, content: content(goodHrefs) })), plan, HOST);
  assert(!textChanged.ok && textChanged.reasons.some((r) => r.includes("텍스트")), "텍스트 달라지면 실패");

  const imageLost = checkEditInvariants(before, snapshotFromRaw(raw({ images: 0, hrefs: goodHrefs, content: content(goodHrefs) })), plan, HOST);
  assert(!imageLost.ok && imageLost.reasons.some((r) => r.includes("이미지")), "이미지 수 달라지면 실패");

  const extra = [...goodHrefs, "https://x.example"];
  const linkAdded = checkEditInvariants(before, snapshotFromRaw(raw({ hrefs: extra, content: content(extra) })), plan, HOST);
  assert(!linkAdded.ok && linkAdded.reasons.some((r) => r.includes("링크 수")), "링크 수 달라지면 실패");

  const collateral = goodHrefs.map((h, i) => (i === 0 ? "https://evil.example" : h));
  const other = checkEditInvariants(before, snapshotFromRaw(raw({ hrefs: collateral, content: content(collateral) })), plan, HOST);
  assert(!other.ok && other.reasons.some((r) => r.includes("계획에 없는")), "계획 밖 href 변경이면 실패");

  const notApplied = checkEditInvariants(before, snapshotFromRaw(raw()), plan, HOST);
  assert(!notApplied.ok && notApplied.reasons.some((r) => r.includes("바뀌지 않았")), "안 바뀌었으면 실패");

  // DOM은 바뀌었는데 직렬화 본문(저장되는 쪽)은 옛 주소 그대로 - data-mce-href 미반영 같은 경우.
  const stale = checkEditInvariants(before, snapshotFromRaw(raw({ hrefs: goodHrefs, content: content(hrefs) })), plan, HOST);
  assert(!stale.ok && stale.reasons.some((r) => r.includes("직렬화 본문에 옛 주소")), "직렬화 본문에 옛 주소 남으면 실패");

  const empty = checkEditInvariants(before, before, [], HOST);
  assert(!empty.ok && empty.reasons.some((r) => r.includes("계획 0건")), "계획 0건이면 발행하지 않는다");
  console.log("✅ checkEditInvariants - 텍스트·이미지·링크 수 동일 + 계획한 href만 + 직렬화 본문 확인");
}

console.log("\n✅ testTistoryPostEdit 전부 통과");
