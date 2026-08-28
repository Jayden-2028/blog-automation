// publishArticleToNaver 테스트. 실제 Supabase/Playwright를 호출하지 않는다 -
// loadJob/loadArticles/loadImages/loadExistingPublications/savePublication/saveDraft 전부
// 주입해서 오케스트레이션 로직(상태 가드, 멱등성, 데이터 조립)만 검증한다.

import { publishArticleToNaver } from "./publishArticleToNaver.js";
import type { PublishArticleToNaverOptions } from "./publishArticleToNaver.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BASE_JOB: ArticleJobRow = {
  id: "job-1",
  source_run_id: 1,
  source_rank: 1,
  keyword: "테스트 키워드",
  headline: null,
  seed_query: null,
  category: "living",
  total_score: 80,
  score_breakdown: null,
  status: "approved",
  selected_at: "2026-08-28T00:00:00.000Z",
  selected_via: "telegram",
  // job.metadata는 더 이상 hashtags를 따로 읽지 않는다(본문 텍스트로만 전달) - 다른 필드가
  // 섞여 있어도 무시된다는 걸 보여주기 위해 관련 없는 값 하나만 남겨둔다.
  metadata: { seoDescription: "테스트용 설명" },
  created_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
};

const BASE_ARTICLE: ArticleRow = {
  id: 42,
  keyword_id: null,
  job_id: "job-1",
  title: "테스트 원고 제목",
  // 해시태그 줄은 runArticleJob.ts가 본문 끝에 그대로 붙여둔다(별도 필드가 아니다) - paste되는
  // bodyHtml에 이 텍스트가 그대로 남아야 한다(2026-08-28 §10 item 7 이후 사용자 결정).
  content: "## 첫 섹션\n\n본문입니다.\n\n![대표 이미지](https://example.com/main.png)\n\n#태그1 #태그2",
  status: "approved",
  ai_model: "test",
  created_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
};

function makeOptions(overrides: Partial<PublishArticleToNaverOptions> = {}): PublishArticleToNaverOptions {
  return {
    loadJob: async () => BASE_JOB,
    loadArticles: async () => [BASE_ARTICLE],
    loadImages: async () => [{ image_url: "https://example.com/main.png", alt_text: "대표 이미지" }],
    loadExistingPublications: async () => [],
    savePublication: async ({ articleId, status, publishedUrl }) =>
      ({
        id: 1,
        article_id: articleId,
        platform: "naver",
        status,
        published_url: publishedUrl,
        published_at: null,
        created_at: "2026-08-28T00:00:00.000Z",
      }) satisfies PublicationRow,
    saveDraft: async () => ({ ok: true, draftUrl: "https://blog.naver.com/bj2028/postwrite?categoryNo=32" }),
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("▶ publishArticleToNaver 테스트 시작\n");

  // 1) job을 못 찾으면 job_not_found
  const notFound = await publishArticleToNaver("missing", makeOptions({ loadJob: async () => null }));
  assert(notFound.ok === false && notFound.reason === "job_not_found", "job 없음 처리 실패");
  console.log("✅ job을 못 찾으면 job_not_found");

  // 2) job.status가 approved가 아니면 job_not_approved (saveDraft가 호출되면 안 된다)
  let saveDraftCalled = false;
  const notApproved = await publishArticleToNaver(
    "job-1",
    makeOptions({
      loadJob: async () => ({ ...BASE_JOB, status: "review" }),
      saveDraft: async () => {
        saveDraftCalled = true;
        return { ok: true, draftUrl: "should-not-be-called" };
      },
    })
  );
  assert(notApproved.ok === false && notApproved.reason === "job_not_approved", "미승인 job 처리 실패");
  assert(!saveDraftCalled, "미승인 job인데 saveDraft가 호출됐다");
  console.log("✅ job.status !== approved -> job_not_approved (saveDraft 호출 안 함)");

  // 3) 연결된 원고가 없으면 article_not_found
  const noArticle = await publishArticleToNaver("job-1", makeOptions({ loadArticles: async () => [] }));
  assert(noArticle.ok === false && noArticle.reason === "article_not_found", "원고 없음 처리 실패");
  console.log("✅ 연결된 원고가 없으면 article_not_found");

  // 4) 이미 pending publication이 있으면 재실행하지 않고 기존 기록을 그대로 돌려준다(멱등성)
  let saveDraftCalledOnRetry = false;
  const existingPub: PublicationRow = {
    id: 99,
    article_id: 42,
    platform: "naver",
    status: "pending",
    published_url: "https://blog.naver.com/bj2028/postwrite?categoryNo=32",
    published_at: null,
    created_at: "2026-08-28T00:00:00.000Z",
  };
  const alreadyDone = await publishArticleToNaver(
    "job-1",
    makeOptions({
      loadExistingPublications: async () => [existingPub],
      saveDraft: async () => {
        saveDraftCalledOnRetry = true;
        return { ok: true, draftUrl: "should-not-be-called" };
      },
    })
  );
  assert(alreadyDone.ok === true && alreadyDone.alreadyDone === true, "멱등성 처리 실패");
  assert(alreadyDone.ok === true && alreadyDone.draftUrl === existingPub.published_url, "기존 draftUrl을 돌려줘야 한다");
  assert(!saveDraftCalledOnRetry, "이미 pending인데 saveDraft가 다시 호출됐다");
  console.log("✅ 이미 pending publication이 있으면 재실행 없이 기존 기록 반환(멱등성)");

  // 5) 성공 경로 - images가 올바르게 조립되고, 해시태그는 본문 텍스트로만(별도 필드 없이)
  // paste되고, publication이 pending으로 기록된다
  let capturedSaveDraftInput: unknown;
  let capturedPublicationInput: unknown;
  const success = await publishArticleToNaver(
    "job-1",
    makeOptions({
      saveDraft: async (input) => {
        capturedSaveDraftInput = input;
        return { ok: true, draftUrl: "https://blog.naver.com/bj2028/postwrite?categoryNo=32" };
      },
      savePublication: async (input) => {
        capturedPublicationInput = input;
        return {
          id: 7,
          article_id: input.articleId,
          platform: "naver",
          status: input.status,
          published_url: input.publishedUrl,
          published_at: null,
          created_at: "2026-08-28T00:00:00.000Z",
        };
      },
    })
  );
  assert(success.ok === true && success.alreadyDone === false, `성공 결과여야 한다 (실제: ${JSON.stringify(success)})`);
  assert(success.ok === true && success.imageCount === 1, "이미지 1건이 잡혀야 한다");
  const saveDraftInput = capturedSaveDraftInput as { title: string; bodyHtml: string; images: { url: string }[] };
  assert(saveDraftInput.title === "테스트 원고 제목", "제목이 article.title이어야 한다");
  assert(!("hashtags" in saveDraftInput), "saveDraft 입력에 별도 hashtags 필드가 없어야 한다(본문 텍스트로만 전달)");
  assert(saveDraftInput.images.length === 1 && saveDraftInput.images[0].url === "https://example.com/main.png", "images 테이블 이미지가 전달돼야 한다");
  assert(!saveDraftInput.bodyHtml.includes("<img"), `본문 HTML에는 이미지가 없어야 한다(toolbar로 따로 업로드) (실제: ${saveDraftInput.bodyHtml})`);
  assert(saveDraftInput.bodyHtml.includes("#태그1 #태그2"), `해시태그는 본문 텍스트로 그대로 남아 paste돼야 한다 (실제: ${saveDraftInput.bodyHtml})`);
  const publicationInput = capturedPublicationInput as { status: string; publishedUrl: string };
  assert(publicationInput.status === "pending", "성공 시 publications.status는 pending이어야 한다(발행 확정 아님)");
  console.log("✅ 성공 경로: images 조립 + 해시태그는 본문 텍스트로만 전달 + 이미지 블록 제거 + publications.status=pending");

  // 6) NaverBlogPublisher 실패 시 stage/error가 그대로 전달되고 failed publication이 기록된다
  let failedPublicationRecorded = false;
  const failure = await publishArticleToNaver(
    "job-1",
    makeOptions({
      saveDraft: async () => ({ ok: false, stage: "body", error: "본문 붙여넣기 대상을 찾지 못했습니다." }),
      savePublication: async (input) => {
        if (input.status === "failed") failedPublicationRecorded = true;
        return {
          id: 8,
          article_id: input.articleId,
          platform: "naver",
          status: input.status,
          published_url: input.publishedUrl,
          published_at: null,
          created_at: "2026-08-28T00:00:00.000Z",
        };
      },
    })
  );
  assert(failure.ok === false && failure.reason === "naver_save_failed", "실패 결과여야 한다");
  assert(failure.ok === false && failure.stage === "body", "실패 stage가 그대로 전달돼야 한다");
  assert(failedPublicationRecorded, "실패도 publications에 기록돼야 한다(조용히 죽으면 안 된다)");
  console.log("✅ NaverBlogPublisher 실패 -> stage/error 전달 + failed publication 기록");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
