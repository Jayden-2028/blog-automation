// publishArticleToBlogspot 오케스트레이션 테스트. 모든 의존성(DB/LLM/Blogger)을 주입한다.
import { publishArticleToBlogspot } from "./publishArticleToBlogspot.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
  return {
    id: "job-1",
    source_run_id: 1,
    source_rank: 1,
    keyword: "근로장려금 지급일",
    headline: null,
    seed_query: "근로장려금",
    category: "living",
    total_score: 60,
    score_breakdown: null,
    status: "approved",
    selected_at: "2026-08-31T00:00:00Z",
    selected_via: "telegram",
    metadata: {},
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    ...overrides,
  } as ArticleJobRow;
}

function article(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 1,
    keyword_id: null,
    job_id: "job-1",
    title: "기준 원고 제목",
    content: "## 섹션\n\n본문 내용입니다. ".repeat(20),
    status: "approved",
    ai_model: "claude",
    platform: null,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    ...overrides,
  };
}

const baseDeps = {
  enabled: true,
  loadJob: async () => job(),
  loadArticles: async () => [article()],
  createVariantArticle: async (i: { jobId: string; title: string; content: string }) =>
    article({ id: 2, platform: "blogspot", title: i.title, content: i.content }),
  loadExistingPublications: async () => [] as PublicationRow[],
  savePublication: async (i: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) =>
    ({ id: 99, article_id: i.articleId, platform: "blogspot", status: i.status, published_url: i.publishedUrl, published_at: null, created_at: "x" }) as PublicationRow,
  countToday: async () => 0,
  generateVariant: async () => ({
    status: "success" as const,
    variant: {
      title: "배리에이션 제목",
      searchDescription: "설명",
      slug: "geunro-guide",
      tags: ["근로장려금"],
      body: "## 배리에이션 섹션\n\n다시 쓴 본문입니다. ".repeat(20),
    },
    durationMs: 10,
  }),
  insertPost: async () => ({ ok: true as const, postId: "p1", url: "https://b.example.com/p1.html", isDraft: true }),
};

async function main(): Promise<void> {
  console.log("▶ publishArticleToBlogspot 테스트 시작\n");

  // 1) disabled -> reason: disabled
  const disabled = await publishArticleToBlogspot("job-1", { ...baseDeps, enabled: false });
  assert(disabled.ok === false && disabled.reason === "disabled", "disabled 처리 실패");
  console.log("✅ enabled=false -> disabled");

  // 2) job이 approved가 아니면 skip
  const notApproved = await publishArticleToBlogspot("job-1", { ...baseDeps, loadJob: async () => job({ status: "review" }) });
  assert(notApproved.ok === false && notApproved.reason === "job_not_approved", "미승인 처리 실패");
  console.log("✅ approved 아님 -> job_not_approved");

  // 3) 일일 상한 도달 -> deferred(재시도). 배리에이션 LLM은 호출되지 않아야 한다.
  let variantCalls = 0;
  const limited = await publishArticleToBlogspot("job-1", {
    ...baseDeps,
    countToday: async () => 5,
    generateVariant: async () => {
      variantCalls++;
      return baseDeps.generateVariant();
    },
  });
  assert(limited.ok === false && limited.reason === "daily_limit", "일일 상한 처리 실패");
  assert(variantCalls === 0, "상한 초과 시 배리에이션 LLM을 호출하면 안 된다");
  console.log("✅ 일일 상한 -> daily_limit, LLM 미호출");

  // 4) 정상: 배리에이션 생성 + draft 발행 + publications pending 기록
  const ok = await publishArticleToBlogspot("job-1", baseDeps);
  assert(ok.ok === true && ok.isDraft === true && ok.variantCreated === true, `정상 발행 실패 (${JSON.stringify(ok)})`);
  console.log("✅ 정상 -> 배리에이션 생성 + draft 발행 + 기록");

  // 5) 멱등성: 배리에이션 article이 이미 있고 그 publication이 published면 재발행 안 함
  let insertCalls = 0;
  const already = await publishArticleToBlogspot("job-1", {
    ...baseDeps,
    loadArticles: async () => [article(), article({ id: 2, platform: "blogspot" })],
    loadExistingPublications: async (articleId: number) =>
      articleId === 2
        ? [{ id: 7, article_id: 2, platform: "blogspot", status: "published", published_url: "https://b/x", published_at: null, created_at: "x" } as PublicationRow]
        : [],
    insertPost: async () => {
      insertCalls++;
      return baseDeps.insertPost();
    },
  });
  assert(already.ok === true && already.alreadyDone === true, `멱등성 실패 (${JSON.stringify(already)})`);
  assert(insertCalls === 0, "이미 발행된 배리에이션은 insertPost를 호출하면 안 된다");
  console.log("✅ 멱등성 -> 이미 발행됨이면 재발행 없음");

  // 6) Blogger insert 실패 -> failed 기록 + reason blogger_failed
  let savedFailed = false;
  const failed = await publishArticleToBlogspot("job-1", {
    ...baseDeps,
    insertPost: async () => ({ ok: false as const, stage: "insert", error: "quota" }),
    savePublication: async (i) => {
      if (i.status === "failed") savedFailed = true;
      return baseDeps.savePublication(i);
    },
  });
  assert(failed.ok === false && failed.reason === "blogger_failed", "Blogger 실패 처리 실패");
  assert(savedFailed, "실패도 publications에 기록해야 한다");
  console.log("✅ Blogger 실패 -> blogger_failed + failed 기록");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
