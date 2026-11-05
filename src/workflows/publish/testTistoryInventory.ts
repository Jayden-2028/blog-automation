// 티스토리 발행본 적립 테스트(2026-11-05). 실제 RSS에서 떠온 모양을 그대로 쓴다 - 파싱이 깨지면
// 적립이 통째로 비는데, 그걸 알려 주는 것은 이 테스트뿐이다(쓰기는 CLI에만 있어 여기서 돌지 않는다).
import {
  decodeEntities,
  inventorySummary,
  normalizeTitle,
  normalizeUrl,
  parseTistoryRss,
  planInventory,
  postIdFromGuid,
  type InventoryArticle,
} from "./tistoryPublishedInventory.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 2026-11-05 실측 응답의 구조(제목·주소·카테고리·태그·guid·pubDate). 제목의 `&amp;middot;`가 핵심이다.
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>왜이슈</title>
  <item>
      <title>남편 있는 동료 성폭행&amp;middot;교제 강요 20대 여성 송치, 혐의와 현재 단계</title>
      <link>https://wooahpapa.tistory.com/entry/%EB%82%A8%ED%8E%B8-%EC%9E%88%EB%8A%94</link>
      <description>&lt;p&gt;본문&lt;/p&gt;</description>
      <category>이슈 해설/사건&amp;middot;사고와 재판</category>
      <category>남양주남부경찰서</category>
      <author>왜이슈</author>
      <guid isPermaLink="true">https://wooahpapa.tistory.com/145</guid>
      <pubDate>Thu, 5 Nov 2026 01:05:40 +0900</pubDate>
  </item>
  <item>
      <title>두 번째 글</title>
      <link>https://wooahpapa.tistory.com/entry/second</link>
      <guid isPermaLink="true">https://wooahpapa.tistory.com/144</guid>
      <pubDate>Wed, 4 Nov 2026 00:09:42 +0900</pubDate>
  </item>
  <item>
      <title>주소가 이미 적립된 글</title>
      <link>https://wooahpapa.tistory.com/entry/third</link>
      <guid isPermaLink="true">https://wooahpapa.tistory.com/143</guid>
      <pubDate>Tue, 3 Nov 2026 10:00:00 +0900</pubDate>
  </item>
  <item>
      <title>티스토리에서 직접 쓴 글</title>
      <link>https://wooahpapa.tistory.com/entry/manual</link>
      <guid isPermaLink="true">https://wooahpapa.tistory.com/142</guid>
      <pubDate>Mon, 2 Nov 2026 10:00:00 +0900</pubDate>
  </item>
</channel></rss>`;

// ── 1. 엔티티·정규화 ──────────────────────────────────────────────
{
  assert(decodeEntities("성폭행&amp;middot;교제") === "성폭행·교제", "두 겹 인코딩(&amp;middot;)을 풀어야 한다");
  assert(decodeEntities("&lt;p&gt;") === "<p>", "한 겹 인코딩도 푼다");
  assert(decodeEntities("A &amp; B") === "A & B", "&amp;는 &로");
  assert(normalizeTitle("  성폭행&amp;middot;교제   강요 ") === "성폭행·교제 강요", "공백 접기 + 엔티티 해제");
  assert(normalizeTitle("ABC") === normalizeTitle("abc"), "대소문자를 가리지 않는다");
  assert(
    normalizeUrl("https://b.tistory.com/entry/%EA%B0%80/") === normalizeUrl("https://b.tistory.com/entry/가"),
    "퍼센트 인코딩·끝 슬래시 차이는 같은 주소다"
  );
  assert(postIdFromGuid("https://wooahpapa.tistory.com/145") === "145", "guid에서 permalink 번호");
  assert(postIdFromGuid(null) === null, "guid가 없으면 null");
  console.log("✅ 엔티티 해제·제목/주소 정규화");
}

// ── 2. RSS 파싱 ───────────────────────────────────────────────────
const items = parseTistoryRss(RSS);
{
  assert(items.length === 4, `item 4건을 읽어야 한다(실제: ${items.length})`);
  assert(items[0].title === "남편 있는 동료 성폭행·교제 강요 20대 여성 송치, 혐의와 현재 단계", "제목 엔티티가 풀려야 한다");
  assert(items[0].url === "https://wooahpapa.tistory.com/entry/%EB%82%A8%ED%8E%B8-%EC%9E%88%EB%8A%94", "link 그대로");
  assert(items[0].postId === "145", "guid의 번호");
  assert(items[0].publishedAt === "2026-11-04T16:05:40.000Z", "pubDate(+0900)를 ISO로");
  assert(items[0].category === "이슈 해설/사건·사고와 재판", "첫 category만 카테고리 경로로 쓴다(태그는 버린다)");
  assert(items[1].category === null, "category가 없으면 null");
  console.log("✅ RSS 파싱 - 제목·주소·permalink·시각·카테고리");
}

// ── 3. 적립 계획 ──────────────────────────────────────────────────
{
  const articles: InventoryArticle[] = [
    // 행이 없다 -> 새로 적립
    { articleId: 11, jobId: "job-1", title: "남편 있는 동료 성폭행·교제 강요 20대 여성 송치, 혐의와 현재 단계" },
    // 행은 있는데 주소가 비었다 -> 주소 교정
    { articleId: 12, jobId: "job-2", title: "두 번째 글", publicationId: 91, recordedUrl: null },
    // 같은 주소로 이미 적립돼 있다 -> 할 일 없음
    { articleId: 13, jobId: "job-3", title: "주소가 이미 적립된 글", publicationId: 92, recordedUrl: "https://wooahpapa.tistory.com/entry/third" },
  ];

  const plan = planInventory(items, articles);
  assert(plan.actions.length === 2, `할 일 2건(실제: ${plan.actions.length})`);
  assert(plan.actions[0].kind === "record" && plan.actions[0].article.articleId === 11, "행이 없으면 insert");
  assert(plan.actions[1].kind === "fix-url" && plan.actions[1].kind === "fix-url" && plan.actions[1].publicationId === 91, "행이 있고 주소가 다르면 update");
  assert(plan.already === 1, "같은 주소는 이미 적립으로 센다");
  assert(plan.unmatched.length === 1 && plan.unmatched[0].title === "티스토리에서 직접 쓴 글", "제목으로 못 찾은 글은 미확인");

  // 두 번째 실행은 아무것도 하지 않는다(멱등) - 적립이 끝난 상태를 만들어 다시 돌려 본다.
  const after: InventoryArticle[] = articles.map((article, index) => ({
    ...article,
    publicationId: article.publicationId ?? 90 + index,
    recordedUrl: items[index]?.url ?? article.recordedUrl,
  }));
  const again = planInventory(items, after);
  assert(again.actions.length === 0, "같은 날 두 번 돌려도 두 번째는 할 일이 없다");
  assert(again.already === 3, "세 건 모두 이미 적립");
  console.log("✅ 적립 계획 - insert/update/이미 적립/미확인, 멱등");
}

// ── 4. 같은 제목이 겹칠 때 ────────────────────────────────────────
{
  // 제목이 같은 article이 둘(수정 재작성)이면 **작은 id**를 쓴다 - 실행마다 같은 선택이어야 한다.
  const dup: InventoryArticle[] = [
    { articleId: 30, jobId: "job-b", title: "두 번째 글" },
    { articleId: 20, jobId: "job-a", title: "두 번째 글" },
  ];
  const plan = planInventory([items[1]], dup);
  assert(plan.actions.length === 1 && plan.actions[0].article.articleId === 20, "제목이 같으면 작은 articleId");

  // 같은 제목의 글이 블로그에 두 개 올라가 있으면 둘째는 미확인이다 - 한 원고에 두 주소를 붙이지 않는다.
  const twice = planInventory([items[1], { ...items[1], url: "https://wooahpapa.tistory.com/entry/second-2", postId: "150" }], dup);
  assert(twice.actions.length === 1 && twice.unmatched.length === 1, "같은 원고를 두 글에 붙이지 않는다");
  console.log("✅ 제목 중복 - 선택이 실행마다 같고, 한 원고에 한 주소만");
}

// ── 5. 요약 문구 ──────────────────────────────────────────────────
{
  const plan = planInventory(items, [{ articleId: 11, jobId: "job-1", title: "두 번째 글" }]);
  const summary = inventorySummary(plan, items.length);
  assert(summary.includes("RSS 4건") && summary.includes("새로 적립 1") && summary.includes("미확인 3"), `요약 문구: ${summary}`);
  console.log("✅ 요약 문구");
}

console.log("\n✅ testTistoryInventory 전체 통과");
