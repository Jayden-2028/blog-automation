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
  let patchedHtml = "";
  let patchedBeforePublish = false;
  const statusUpdates: unknown[] = [];
  const result = await publishArticleToBlogspot(
    "job-1",
    options({
      loadJobPublications: async () => [
        { id: 7, status: "pending", published_url: "https://www.blogger.com/blog/post/edit/111/222" },
      ],
      insertPost: async () => {
        inserted += 1;
        return { ok: true as const, postId: "999", url: "https://new", isDraft: false };
      },
      updatePost: async (postId: string, input: { contentHtml: string }) => {
        assert(postId === "222", "초안 postId를 덮어써야 한다");
        patchedHtml = input.contentHtml;
        return { ok: true as const, postId };
      },
      publishPost: async (postId: string) => {
        promotedId = postId;
        patchedBeforePublish = patchedHtml !== "";
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
  // 초안 본문에 남아 있던 `[IMAGE: ... ]` 마커 텍스트가 공개되면 독자에게 그대로 보인다.
  assert(patchedBeforePublish, "공개 전에 본문을 먼저 덮어써야 한다");
  assert(!patchedHtml.includes("[IMAGE:"), `공개 본문에 마커 텍스트가 남으면 안 된다 (${patchedHtml})`);
  console.log("✅ 초안이 남아 있으면 새 글 대신 공개 전환 + 본문을 공개용으로 덮어씀");
}

// --- 본문 덮어쓰기가 실패하면 공개하지 않는다 -----------------------------------------------
{
  let promoted = 0;
  const result = await publishArticleToBlogspot(
    "job-1",
    options({
      loadJobPublications: async () => [
        { id: 7, status: "pending", published_url: "https://www.blogger.com/blog/post/edit/111/222" },
      ],
      insertPost: async () => ({ ok: true as const, postId: "999", url: "https://new", isDraft: false }),
      updatePost: async () => ({ ok: false as const, stage: "update" as const, error: "429" }),
      publishPost: async () => {
        promoted += 1;
        return {} as never;
      },
    }) as never
  );
  assert(promoted === 0, "본문을 못 고쳤으면 공개하면 안 된다");
  assert(!result.ok && result.reason === "blogger_failed", "실패를 그대로 알려야 한다");
  console.log("✅ 본문 덮어쓰기 실패 시 공개를 막는다");
}

// --- 이미 공개된 글이고 postId도 못 찾으면 그대로 알린다 -----------------------------------------
{
  let promoted = 0;
  const result = await publishArticleToBlogspot(
    "job-1",
    options({
      loadJobPublications: async () => [
        { id: 7, status: "published", published_url: "https://blog.example.com/2026/09/p.html" },
      ],
      insertPost: async () => ({ ok: true as const, postId: "999", url: "https://new", isDraft: false }),
      findPostIdByPath: async () => null,
      publishPost: async () => {
        promoted += 1;
        return {} as never;
      },
    }) as never
  );
  assert(promoted === 0, "이미 공개된 글을 다시 전환하면 안 된다");
  assert(result.ok && result.alreadyDone, "alreadyDone이어야 한다");
  console.log("✅ 이미 공개된 글 + postId 미확인 -> 그대로 알린다");
}

// --- 수정 반영: 이미 공개된 글은 새로 올리지 않고 본문만 덮어쓴다 ---------------------------------
// 수정이 들어오면 배리에이션 article row가 새로 생긴다. 그 row의 publication만 보면 "아직 안
// 올렸다"로 보여 같은 글이 블로그에 두 번 올라간다 - job 전체의 publication을 봐야 한다.
{
  let inserted = 0;
  let promoted = 0;
  let patchedTo = "";
  let askedPath = "";
  const result = await publishArticleToBlogspot(
    "job-1",
    options({
      // 수정 반영으로 배리에이션이 새로 생긴 상태(id 3). 옛 배리에이션(id 2)에 publication이 있다.
      loadArticles: async () => [base, variant, { id: 3, platform: "blogspot", title: "수정 제목", content: "수정 본문" }],
      loadJobPublications: async (articleIds: number[]) => {
        assert(articleIds.includes(2), "job 전체 article의 publication을 봐야 한다");
        return [{ id: 7, status: "published", published_url: "https://blog.example.com/2026/09/p.html" }] as never;
      },
      findPostIdByPath: async (path: string) => {
        askedPath = path;
        return "555";
      },
      updatePost: async (postId: string, input: { title: string; contentHtml: string }) => {
        assert(postId === "555", "주소로 찾은 postId를 덮어써야 한다");
        patchedTo = input.contentHtml;
        return { ok: true as const, postId };
      },
      insertPost: async () => {
        inserted += 1;
        return { ok: true as const, postId: "999", url: "https://new", isDraft: false };
      },
      publishPost: async () => {
        promoted += 1;
        return {} as never;
      },
      markPublished: async () => {},
    }) as never
  );

  assert(inserted === 0, "이미 공개된 글이 있으면 새 글을 올리면 안 된다(중복 게시)");
  assert(promoted === 0, "이미 공개된 글을 다시 publish할 필요는 없다");
  assert(askedPath === "/2026/09/p.html", `공개 URL의 경로로 postId를 찾아야 한다 (${askedPath})`);
  assert(patchedTo.includes("수정 본문"), `수정된 최신 배리에이션으로 덮어써야 한다 (${patchedTo})`);
  assert(result.ok && result.updatedExisting, "본문 갱신이었음을 알려야 한다");
  assert(result.ok && result.url.includes("blog.example.com"), "주소는 그대로여야 한다");
  console.log("✅ 수정 반영 -> 기존 공개 글의 본문만 덮어씀(중복 게시 없음)");
}

console.log("\n🎉 초안 공개 전환 테스트 통과");
