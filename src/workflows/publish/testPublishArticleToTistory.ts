// publishArticleToTistory 오케스트레이션 테스트. 모든 의존성(DB/LLM/Playwright)을 주입한다.
import { publishArticleToTistory } from "./publishArticleToTistory.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const job = (o: Partial<ArticleJobRow> = {}): ArticleJobRow =>
  ({
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
    selected_at: "x",
    selected_via: "telegram",
    metadata: {},
    created_at: "x",
    updated_at: "x",
    ...o,
  }) as ArticleJobRow;

const article = (o: Partial<ArticleRow> = {}): ArticleRow => ({
  id: 1,
  keyword_id: null,
  job_id: "job-1",
  title: "기준 원고 제목",
  content: "## 섹션\n\n본문. ".repeat(20),
  status: "approved",
  ai_model: "claude",
  platform: null,
  created_at: "x",
  updated_at: "x",
  ...o,
});

const base = {
  enabled: true,
  loadJob: async () => job(),
  loadArticles: async () => [article()],
  createVariantArticle: async (i: { title: string; content: string }) =>
    article({ id: 2, platform: "tistory", title: i.title, content: i.content }),
  loadExistingPublications: async () => [] as PublicationRow[],
  savePublication: async (i: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) =>
    ({ id: 99, article_id: i.articleId, platform: "tistory", status: i.status, published_url: i.publishedUrl, published_at: null, created_at: "x" }) as PublicationRow,
  countToday: async () => 0,
  generateVariant: async () => ({
    status: "success" as const,
    variant: { title: "티스토리 제목", searchDescription: "d", slug: null, tags: ["근로장려금"], body: "## 배리에이션\n\n다시 쓴 본문. ".repeat(20) },
    durationMs: 10,
  }),
  saveDraft: async () => ({ ok: true as const, draftUrl: "https://wooahpapa.tistory.com/manage/posts/" }),
};

async function main(): Promise<void> {
  console.log("▶ publishArticleToTistory 테스트 시작\n");

  const disabled = await publishArticleToTistory("job-1", { ...base, enabled: false });
  assert(disabled.ok === false && disabled.reason === "disabled", "disabled 처리 실패");
  console.log("✅ enabled=false -> disabled");

  const notApproved = await publishArticleToTistory("job-1", { ...base, loadJob: async () => job({ status: "review" }) });
  assert(notApproved.ok === false && notApproved.reason === "job_not_approved", "미승인 처리 실패");
  console.log("✅ approved 아님 -> job_not_approved");

  let variantCalls = 0;
  const limited = await publishArticleToTistory("job-1", {
    ...base,
    countToday: async () => 5,
    generateVariant: async () => {
      variantCalls++;
      return base.generateVariant();
    },
  });
  assert(limited.ok === false && limited.reason === "daily_limit", "일일 상한 처리 실패");
  assert(variantCalls === 0, "상한 초과 시 배리에이션 LLM을 호출하면 안 된다");
  console.log("✅ 일일 상한 -> daily_limit, LLM 미호출");

  const ok = await publishArticleToTistory("job-1", base);
  assert(ok.ok === true && ok.variantCreated === true, `정상 임시저장 실패 (${JSON.stringify(ok)})`);
  console.log("✅ 정상 -> 배리에이션 생성 + 임시저장 + pending 기록");

  let saveCalls = 0;
  const already = await publishArticleToTistory("job-1", {
    ...base,
    loadArticles: async () => [article(), article({ id: 2, platform: "tistory" })],
    loadExistingPublications: async (articleId: number) =>
      articleId === 2
        ? [{ id: 7, article_id: 2, platform: "tistory", status: "pending", published_url: "https://t/x", published_at: null, created_at: "x" } as PublicationRow]
        : [],
    saveDraft: async () => {
      saveCalls++;
      return base.saveDraft();
    },
  });
  assert(already.ok === true && already.alreadyDone === true, "멱등성 실패");
  assert(saveCalls === 0, "이미 임시저장된 배리에이션은 saveDraft를 호출하면 안 된다");
  console.log("✅ 멱등성 -> 이미 임시저장됨이면 재저장 없음");

  let savedFailed = false;
  const failed = await publishArticleToTistory("job-1", {
    ...base,
    saveDraft: async () => ({ ok: false as const, stage: "body", error: "tinymce 인스턴스 없음" }),
    savePublication: async (i) => {
      if (i.status === "failed") savedFailed = true;
      return base.savePublication(i);
    },
  });
  assert(failed.ok === false && failed.reason === "tistory_save_failed" && failed.stage === "body", "저장 실패 처리 실패");
  assert(savedFailed, "실패도 publications에 기록해야 한다");
  console.log("✅ 임시저장 실패 -> tistory_save_failed(stage) + failed 기록");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
