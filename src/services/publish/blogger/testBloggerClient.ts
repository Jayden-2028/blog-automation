// BloggerClient 테스트. fetch를 주입해 실제 구글 API를 호출하지 않는다.
import { BloggerClient } from "./BloggerClient.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function fakeFetch(handlers: {
  token?: (body: string) => { status: number; json: unknown };
  insert?: (url: string, body: unknown) => { status: number; json: unknown };
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      const r = handlers.token?.(String(init?.body ?? "")) ?? { status: 200, json: { access_token: "at-1" } };
      return { ok: r.status < 400, status: r.status, json: async () => r.json } as Response;
    }
    if (url.includes("/blogger/v3/blogs/")) {
      const r = handlers.insert?.(url, JSON.parse(String(init?.body ?? "{}"))) ?? {
        status: 200,
        json: { id: "post-1", url: "https://blog.example.com/2026/08/post.html" },
      };
      return { ok: r.status < 400, status: r.status, json: async () => r.json } as Response;
    }
    throw new Error(`예상치 못한 fetch: ${url}`);
  }) as typeof fetch;
}

const CONFIG = { clientId: "c", clientSecret: "s", refreshToken: "r", blogId: "b" };

async function main(): Promise<void> {
  console.log("▶ BloggerClient 테스트 시작\n");

  // 1) config 누락 -> stage: "config"
  const noConfig = await new BloggerClient({ fetchImpl: fakeFetch({}) }).insertPost({
    title: "t",
    contentHtml: "<p>c</p>",
  });
  // (실제 .env가 있으면 config가 채워질 수 있으므로, 명시적으로 빈 값을 준다)
  const noConfig2 = await new BloggerClient({
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    blogId: "",
    fetchImpl: fakeFetch({}),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>" });
  assert(noConfig2.ok === false && noConfig2.stage === "config", `config 누락 -> config stage (${JSON.stringify(noConfig2)})`);
  console.log("✅ config 누락 -> stage=config");
  void noConfig;

  // 2) 정상 발행 (isDraft 명시)
  const okDraft = await new BloggerClient({ ...CONFIG, fetchImpl: fakeFetch({}) }).insertPost({
    title: "제목",
    contentHtml: "<p>본문</p>",
    labels: ["생활정보"],
    isDraft: true,
  });
  assert(okDraft.ok && okDraft.postId === "post-1" && okDraft.isDraft === true, `정상 발행 실패 (${JSON.stringify(okDraft)})`);
  console.log("✅ 정상 발행 -> postId/url/isDraft");

  // 3) 토큰 실패 -> stage: "token"
  const tokenFail = await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({ token: () => ({ status: 400, json: { error: "invalid_grant" } }) }),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>" });
  assert(tokenFail.ok === false && tokenFail.stage === "token", `토큰 실패 -> token stage (${JSON.stringify(tokenFail)})`);
  console.log("✅ 토큰 교환 실패 -> stage=token");

  // 4) insert 실패 -> stage: "insert"
  const insertFail = await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({ insert: () => ({ status: 403, json: { error: { message: "권한 없음" } } }) }),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>" });
  assert(insertFail.ok === false && insertFail.stage === "insert" && insertFail.error.includes("권한 없음"), `insert 실패 처리 (${JSON.stringify(insertFail)})`);
  console.log("✅ posts.insert 실패 -> stage=insert + 사유 전달");

  // 5) labels/isDraft가 요청 body/쿼리에 반영되는지
  let capturedUrl = "";
  let capturedBody: { labels?: string[] } = {};
  await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({
      insert: (url, body) => {
        capturedUrl = url;
        capturedBody = body as { labels?: string[] };
        return { status: 200, json: { id: "p", url: "u" } };
      },
    }),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>", labels: ["OTT"], isDraft: false });
  assert(capturedUrl.includes("isDraft=false"), `isDraft 쿼리 반영 실패 (${capturedUrl})`);
  assert(capturedBody.labels?.[0] === "OTT", "labels 반영 실패");
  console.log("✅ isDraft 쿼리 + labels body 반영");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
