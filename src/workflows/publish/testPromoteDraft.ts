// 초안 -> 공개 전환 테스트(2026-09-19). 실제 Blogger를 호출하지 않는다.
//
// 지켜야 할 것: 이미 초안이 올라가 있으면 **새 글을 또 만들지 않고** 그 초안을 공개로 전환한다.
// 같은 원고가 블로그에 두 번 올라가는 것이 이 경로에서 가장 비싼 사고다.

import { extractPostId, publishArticleToBlogspot } from "./publishArticleToBlogspot.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

{
  const url = "https://www.blogger.com/blog/post/edit/1894600431607107632/4717241267817532293";
  assert(extractPostId(url) === "4717241267817532293", `편집 URL에서 postId를 뽑아야 한다 (${extractPostId(url)})`);
  assert(extractPostId("https://blog.example.com/2026/09/p.html") === null, "공개 URL에는 postId가 없다");
  assert(extractPostId(null) === null, "null 안전");
  console.log("✅ 초안 편집 URL에서 postId 추출");
}

const job = { id: "job-1", keyword: "공무원 수당", category: "living", status: "approved", metadata: {} } as never;
const base = { id: 1, platform: null, title: "기준", content: "본문", ai_model: "claude" } as never;
const variant = { id: 2, platform: "blogspot", title: "제목", content: "본문\n\n[IMAGE: 설명 — AI 생성]" } as never;

function options(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    asDraft: false,
    loadJob: async () => job,
    loadArticles: async () => [base, variant],
    countToday: async () => 0,
    savePublication: async () => ({ id: 9 }) as never,
    ...over,
  };
}

// --- 이미 초안이 있으면 새 글을 만들지 않고 공개로 전환한다 -------------------------------------
{
  let inserted = 0;
  let promotedId = "";
  const statusUpdates: unknown[] = [];
  const result = await publishArticleToBlogspot(
    "job-1",
    options({
      loadExistingPublications: async () => [
        { id: 7, status: "pending", published_url: "https://www.blogger.com/blog/post/edit/111/222" },
      ],
      insertPost: async () => {
        inserted += 1;
        return { ok: true as const, postId: "999", url: "https://new", isDraft: false };
      },
      publishPost: async (postId: string) => {
        promotedId = postId;
        return { ok: true as const, postId, url: "https://blog.example.com/2026/09/p.html", status: "LIVE", publishedAt: "", scheduled: false };
      },
      markPublished: async (input: unknown) => {
        statusUpdates.push(input);
      },
    }) as never
  );

  assert(inserted === 0, "이미 올라간 글이 있으면 새 글을 만들면 안 된다");
  assert(promotedId === "222", `초안 postId로 공개 전환해야 한다 (${promotedId})`);
  assert(result.ok && !result.isDraft, "결과는 공개 발행이어야 한다");
  assert(result.ok && result.url.includes("blog.example.com"), `공개 URL을 돌려줘야 한다 (${result.ok ? result.url : ""})`);
  assert(result.ok && !result.alreadyDone, "전환에 성공했으므로 alreadyDone이 아니다");
  assert(statusUpdates.length === 1, "publications/articles 상태를 한 번 갱신해야 한다");
  console.log("✅ 초안이 남아 있으면 새 글 대신 공개 전환");
}

// --- 이미 공개된 글이면 그대로 알린다 ------------------------------------------------------------
{
  let promoted = 0;
  const result = await publishArticleToBlogspot(
    "job-1",
    options({
      loadExistingPublications: async () => [
        { id: 7, status: "published", published_url: "https://blog.example.com/2026/09/p.html" },
      ],
      insertPost: async () => ({ ok: true as const, postId: "999", url: "https://new", isDraft: false }),
      publishPost: async () => {
        promoted += 1;
        return {} as never;
      },
    }) as never
  );
  assert(promoted === 0, "이미 공개된 글을 다시 전환하면 안 된다");
  assert(result.ok && result.alreadyDone, "alreadyDone이어야 한다");
  console.log("✅ 이미 공개된 글은 그대로 알린다");
}

console.log("\n🎉 초안 공개 전환 테스트 통과");
