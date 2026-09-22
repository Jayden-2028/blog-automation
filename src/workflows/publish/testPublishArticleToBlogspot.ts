// publishArticleToBlogspot 오케스트레이션 테스트. 모든 의존성(DB/LLM/Blogger)을 주입한다.
import { publishArticleToBlogspot } from "./publishArticleToBlogspot.js";
import { BLOGGER_CONFIG } from "../../config/publishTargets.js";
import { startOfKstDay } from "../../services/supabase/repositories/publicationRepository.js";
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
  loadJobPublications: async () => [] as PublicationRow[],
  savePublication: async (i: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) =>
    ({ id: 99, article_id: i.articleId, platform: "blogspot", status: i.status, published_url: i.publishedUrl, published_at: null, created_at: "x" }) as PublicationRow,
  countToday: async () => 0,
  generateVariant: async () => ({
    status: "success" as const,
    variant: {
      title: "배리에이션 제목",
      searchDescription: "설명",
      slug: "geunro-guide",
      shortName: "짧은이름",
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
    // 설정값을 그대로 읽는다 - 상한을 조정할 때마다 테스트가 깨지면 안 된다(2026-09-21 5 -> 20).
    countToday: async () => BLOGGER_CONFIG.dailyLimit,
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
    loadJobPublications: async (articleIds: number[]) =>
      articleIds.includes(2)
        ? [{ id: 7, article_id: 2, platform: "blogspot", status: "published", published_url: "https://b/x", published_at: null, created_at: "x" } as PublicationRow]
        : [],
    // 주소로도 postId를 못 찾는 옛 기록 - 덮어쓰기 없이 "이미 발행됨"으로 끝나야 한다.
    findPostIdByPath: async () => null,
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

  // 7) 배리에이션 재사용 경로(이미 있음)에서 job.metadata.channelMeta.blogspot의 searchDescription을
  //    복구해 insertPost에 넘겨야 한다(2026-09-15 재배선 - prepareManuscript.ts가 이미 만들어 둔
  //    배리에이션을 재사용할 때 검색 설명을 잃던 문제).
  let insertedSearchDescription: string | null | undefined;
  const reused = await publishArticleToBlogspot("job-1", {
    ...baseDeps,
    loadJob: async () =>
      job({ metadata: { channelMeta: { blogspot: { searchDescription: "복구된 설명", slug: null, tags: [] } } } }),
    loadArticles: async () => [article(), article({ id: 2, platform: "blogspot", content: "재사용 본문" })],
    generateVariant: async () => {
      throw new Error("재사용 경로에서는 배리에이션을 다시 만들면 안 된다");
    },
    insertPost: async (input) => {
      insertedSearchDescription = input.searchDescription;
      return baseDeps.insertPost();
    },
  });
  assert(reused.ok === true, `배리에이션 재사용 발행 실패 (${JSON.stringify(reused)})`);
  assert(insertedSearchDescription === "복구된 설명", `재사용 시 searchDescription이 복구돼야 한다 (${insertedSearchDescription})`);
  console.log("✅ 배리에이션 재사용 -> job.metadata.channelMeta에서 searchDescription 복구");

  // 8) 본문의 [IMAGE: 설명] 마커가 job.metadata.images에서 확정된(url 있는) 이미지로 치환돼
  //    contentHtml에 실제 <img>로 들어가야 한다(마커 텍스트가 그대로 발행되면 안 된다).
  let insertedHtml = "";
  const withImages = await publishArticleToBlogspot("job-1", {
    ...baseDeps,
    loadJob: async () => job({ metadata: { images: [{ index: 1, description: "설명", prompt: null, url: "https://img.example.com/1.png", provider: "openai", fileName: "01.png" }] } }),
    loadArticles: async () => [article(), article({ id: 2, platform: "blogspot", content: "본문 시작\n\n[IMAGE: 설명]\n\n본문 끝" })],
    generateVariant: async () => {
      throw new Error("재사용 경로에서는 배리에이션을 다시 만들면 안 된다");
    },
    insertPost: async (input) => {
      insertedHtml = input.contentHtml;
      return baseDeps.insertPost();
    },
  });
  assert(withImages.ok === true, `이미지 포함 발행 실패 (${JSON.stringify(withImages)})`);
  assert(insertedHtml.includes("<img src=\"https://img.example.com/1.png\""), `확정 이미지가 HTML에 삽입돼야 한다 (${insertedHtml})`);
  assert(!insertedHtml.includes("[IMAGE:"), "발행 HTML에 마커 텍스트가 그대로 남으면 안 된다");
  console.log("✅ 확정된 자동 생성 이미지가 발행 HTML에 실제 <img>로 삽입됨");

  // 9) A/B 비교로 후보가 2장(아직 미확정)이면 마커를 그대로 두고 발행한다(엉뚱한 이미지 자동 선택 금지).
  let insertedHtmlAb = "";
  const withAbImages = await publishArticleToBlogspot("job-1", {
    ...baseDeps,
    loadJob: async () =>
      job({
        metadata: {
          images: [
            { index: 1, description: "설명", prompt: null, url: "https://img.example.com/a.png", provider: "openai", fileName: "01-openai.png" },
            { index: 1, description: "설명", prompt: null, url: "https://img.example.com/b.png", provider: "gemini", fileName: "01-gemini.png" },
          ],
        },
      }),
    loadArticles: async () => [article(), article({ id: 2, platform: "blogspot", content: "본문 시작\n\n[IMAGE: 설명]\n\n본문 끝" })],
    generateVariant: async () => {
      throw new Error("재사용 경로에서는 배리에이션을 다시 만들면 안 된다");
    },
    insertPost: async (input) => {
      insertedHtmlAb = input.contentHtml;
      return baseDeps.insertPost();
    },
  });
  assert(withAbImages.ok === true, "A/B 미확정 케이스도 발행은 진행돼야 한다");
  assert(insertedHtmlAb.includes("[IMAGE:"), "A/B 후보가 2장이면(미확정) 마커를 그대로 두고 발행해야 한다");
  console.log("✅ A/B 비교 미확정(후보 2장) -> 마커 유지한 채 발행");

  // 10) 초안 vs 공개에서 미충족 마커 처리가 갈린다(2026-09-16).
  //     초안: TODO 표시로 남긴다 / 공개: 독자에게 보이면 안 되므로 제거한다.
  const bodyWithWebSearchMarker =
    "본문 시작\n\n[IMAGE: 국가법령정보센터 조문 화면 — 웹 검색]\n\n본문 끝";
  const runWith = async (publishAsDraft: boolean): Promise<string> => {
    const original = BLOGGER_CONFIG.publishAsDraft;
    (BLOGGER_CONFIG as { publishAsDraft: boolean }).publishAsDraft = publishAsDraft;
    let html = "";
    try {
      await publishArticleToBlogspot("job-1", {
        ...baseDeps,
        loadArticles: async () => [article(), article({ id: 2, platform: "blogspot", content: bodyWithWebSearchMarker })],
        generateVariant: async () => {
          throw new Error("재사용 경로에서는 배리에이션을 다시 만들면 안 된다");
        },
        insertPost: async (input) => {
          html = input.contentHtml;
          return { ok: true as const, postId: "p", url: "u", isDraft: publishAsDraft };
        },
      });
    } finally {
      (BLOGGER_CONFIG as { publishAsDraft: boolean }).publishAsDraft = original;
    }
    return html;
  };

  const draftHtml = await runWith(true);
  assert(draftHtml.includes("[IMAGE:"), "초안에서는 마커를 TODO로 남겨야 한다");

  const publicHtml = await runWith(false);
  assert(!publicHtml.includes("[IMAGE:"), `공개 발행에서는 마커가 독자에게 보이면 안 된다 (${publicHtml})`);
  assert(publicHtml.includes("본문 시작") && publicHtml.includes("본문 끝"), "마커만 지우고 본문은 살려야 한다");
  console.log("✅ 초안 -> 마커 유지(TODO) / 공개 -> 마커 제거, 본문은 보존");

  // 일일 상한의 "오늘"은 한국시간 자정 기준이어야 한다(2026-09-21).
  // 실제로 도는 곳은 UTC 러너라, 로컬 자정을 쓰면 카운터가 한국시간 오전 9시에 초기화된다.
  // 밤에 상한에 걸린 원고가 다음 날 아침 9시까지 막혀, 사용자가 보는 "오늘"과 어긋났다.
  {
    // 한국시간 2026-09-21 08:00 (= UTC 2026-09-20 23:00). 로컬(UTC) 자정 기준이면 9/20으로
    // 새고, 한국시간 기준이면 9/21이 된다 - 둘이 갈리는 시각이라 여기서 잡힌다.
    const beforeNine = startOfKstDay(new Date("2026-09-20T23:00:00Z"));
    assert(beforeNine.toISOString() === "2026-09-20T15:00:00.000Z", `한국시간 자정이어야 한다 (${beforeNine.toISOString()})`);

    // 한국시간 자정 직후도 같은 날이어야 한다(경계가 하루 밀리면 안 된다).
    const justAfterMidnight = startOfKstDay(new Date("2026-09-20T15:00:00Z"));
    assert(justAfterMidnight.toISOString() === "2026-09-20T15:00:00.000Z", `자정 직후는 그날이어야 한다 (${justAfterMidnight.toISOString()})`);

    // 한국시간 자정 1분 전은 전날이다.
    const justBefore = startOfKstDay(new Date("2026-09-20T14:59:00Z"));
    assert(justBefore.toISOString() === "2026-09-19T15:00:00.000Z", `자정 직전은 전날이어야 한다 (${justBefore.toISOString()})`);
    console.log("✅ 일일 상한의 \"오늘\" - 한국시간 자정 기준");
  }

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
