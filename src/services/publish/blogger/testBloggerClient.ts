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

  // 6) 댓글은 기본 비허용으로 나간다(사용자 결정 2026-09-16). 명시 지정도 반영돼야 한다.
  let body6: Record<string, unknown> = {};
  await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({
      insert: (_u, b) => {
        body6 = b as Record<string, unknown>;
        return { status: 200, json: { id: "p", url: "u" } };
      },
    }),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>" });
  assert(
    body6.readerComments === "DONT_ALLOW_HIDE_EXISTING",
    `기본 댓글 설정이 비허용이어야 한다 (${String(body6.readerComments)})`
  );

  let body6b: Record<string, unknown> = {};
  await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({
      insert: (_u, b) => {
        body6b = b as Record<string, unknown>;
        return { status: 200, json: { id: "p", url: "u" } };
      },
    }),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>", readerComments: "ALLOW" });
  assert(body6b.readerComments === "ALLOW", "명시한 댓글 설정이 반영돼야 한다");
  console.log("✅ 댓글 기본 비허용 + 명시 지정 반영");

  // 7) searchDescription을 줘도 customMetaData를 보내지 않는다 - Blogger가 조용히 버리는 필드라
  //    보내면 "설정됐겠지" 착각만 남는다(2026-09-16 실측).
  let body7: Record<string, unknown> = {};
  await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({
      insert: (_u, b) => {
        body7 = b as Record<string, unknown>;
        return { status: 200, json: { id: "p", url: "u" } };
      },
    }),
  }).insertPost({ title: "t", contentHtml: "<p>c</p>", searchDescription: "검색 설명" });
  assert(body7.customMetaData === undefined, "customMetaData를 보내면 안 된다(API가 버린다)");
  console.log("✅ searchDescription을 줘도 customMetaData 미전송");

  // 8) publishPost: 시각을 주면 publishDate 쿼리로 예약, 없으면 즉시 공개.
  let publishUrl = "";
  const scheduled = await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({
      insert: (u) => {
        publishUrl = u;
        return { status: 200, json: { id: "p", url: "https://b/x.html", status: "SCHEDULED", published: "2026-09-17T00:00:00Z" } };
      },
    }),
  }).publishPost("p", new Date("2026-09-17T00:00:00Z"));
  assert(publishUrl.includes("/posts/p/publish"), `publish 엔드포인트를 써야 한다 (${publishUrl})`);
  assert(publishUrl.includes("publishDate=2026-09-17T00%3A00%3A00.000Z"), `publishDate 쿼리 반영 실패 (${publishUrl})`);
  assert(scheduled.ok === true && scheduled.scheduled === true && scheduled.status === "SCHEDULED", "예약 결과 반영 실패");

  let immediateUrl = "";
  const immediate = await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({
      insert: (u) => {
        immediateUrl = u;
        return { status: 200, json: { id: "p", url: "https://b/x.html", status: "LIVE", published: "2026-09-16T00:00:00Z" } };
      },
    }),
  }).publishPost("p");
  assert(!immediateUrl.includes("publishDate"), `시각 없으면 publishDate가 없어야 한다 (${immediateUrl})`);
  assert(immediate.ok === true && immediate.scheduled === false, "즉시 공개 결과 반영 실패");
  console.log("✅ publishPost - 예약(publishDate) / 즉시 공개 구분");

  // 9) publishPost 실패는 stage=publish로 구분된다.
  const publishFail = await new BloggerClient({
    ...CONFIG,
    fetchImpl: fakeFetch({ insert: () => ({ status: 404, json: { error: { message: "없는 글" } } }) }),
  }).publishPost("nope");
  assert(
    publishFail.ok === false && publishFail.stage === "publish" && publishFail.error.includes("없는 글"),
    `publish 실패 처리 (${JSON.stringify(publishFail)})`
  );
  console.log("✅ publishPost 실패 -> stage=publish + 사유 전달");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
