// 승인된 job 1건을 티스토리에 "임시저장"한다(반자동 - 발행 버튼은 사람). SPRINT_5_DESIGN.md §11-11.
// publishArticleToBlogspot.ts와 같은 구조지만, 네이버처럼 임시저장까지만이라 성공 시
// publications.status는 'pending'이다(발행 완료 아님).
//
// 멱등성: tistory 배리에이션 article + platform='tistory'로 pending/publishing/published publication이
// 있으면 재저장하지 않는다. 배리에이션 원고도 이미 있으면 재생성하지 않는다.

import { BLOGSPOT_LABEL_BY_INTERNAL, TISTORY_CONFIG } from "../../config/publishTargets.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { convertArticleToHtml } from "../../services/publish/convertArticleToHtml.js";
import { TistoryPublisher } from "../../services/publish/tistory/TistoryPublisher.js";
import {
  createArticle,
  listArticlesByJobId,
} from "../../services/supabase/repositories/articleRepository.js";
import {
  countTodayPublicationsByPlatform,
  createPublication,
  listPublicationsByArticleId,
} from "../../services/supabase/repositories/publicationRepository.js";
import { generateArticleVariant } from "../writing/generateArticleVariant.js";
import type { GenerateArticleVariantResult } from "../writing/generateArticleVariant.js";
import type { TistoryDraftSaveInput, TistoryDraftSaveResult } from "../../services/publish/tistory/TistoryPublisher.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

export const TISTORY_PLATFORM = "tistory";

const IN_PROGRESS_OR_DONE: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishArticleToTistoryResult =
  | { ok: true; publicationId: number; draftUrl: string; variantCreated: boolean; alreadyDone: boolean }
  | { ok: false; reason: "disabled" | "job_not_found" | "job_not_approved" | "base_article_not_found"; detail: string }
  | { ok: false; reason: "daily_limit"; detail: string }
  | { ok: false; reason: "login_required"; detail: string }
  | { ok: false; reason: "variant_failed"; detail: string }
  | { ok: false; reason: "tistory_save_failed"; detail: string; stage: string };

export type PublishArticleToTistoryOptions = {
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  createVariantArticle?: (input: { jobId: string; title: string; content: string; aiModel: string | null }) => Promise<ArticleRow>;
  loadExistingPublications?: (articleId: number) => Promise<PublicationRow[]>;
  savePublication?: (input: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) => Promise<PublicationRow>;
  countToday?: (platform: string) => Promise<number>;
  generateVariant?: (input: { category: string | null; baseTitle: string; baseBody: string }) => Promise<GenerateArticleVariantResult>;
  saveDraft?: (input: TistoryDraftSaveInput) => Promise<TistoryDraftSaveResult>;
  enabled?: boolean;
};

export async function publishArticleToTistory(
  jobId: string,
  options: PublishArticleToTistoryOptions = {}
): Promise<PublishArticleToTistoryResult> {
  const enabled = options.enabled ?? TISTORY_CONFIG.enabled;
  if (!enabled) return { ok: false, reason: "disabled", detail: "TISTORY_ENABLED=false" };

  const loadJob = options.loadJob ?? ((id) => ArticleJobRepository.findById(id));
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const createVariantArticle =
    options.createVariantArticle ??
    (({ jobId: jid, title, content, aiModel }) =>
      createArticle({ job_id: jid, title, content, status: "approved", ai_model: aiModel, platform: TISTORY_PLATFORM }));
  const loadExistingPublications = options.loadExistingPublications ?? listPublicationsByArticleId;
  const savePublication =
    options.savePublication ??
    (({ articleId, status, publishedUrl }) =>
      createPublication({ article_id: articleId, platform: TISTORY_PLATFORM, status, published_url: publishedUrl }));
  const countToday = options.countToday ?? countTodayPublicationsByPlatform;
  const generateVariant = options.generateVariant ?? ((input) => generateArticleVariant({ channel: "tistory", ...input }));
  const saveDraft = options.saveDraft ?? ((input) => new TistoryPublisher().saveDraft(input));

  const job = await loadJob(jobId);
  if (!job) return { ok: false, reason: "job_not_found", detail: `job을 찾을 수 없습니다: ${jobId}` };
  if (job.status !== "approved") {
    return { ok: false, reason: "job_not_approved", detail: `job 상태가 approved가 아닙니다 (현재: ${job.status})` };
  }

  const articles = await loadArticles(jobId);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) return { ok: false, reason: "base_article_not_found", detail: `기준 원고 없음: ${jobId}` };

  let variantArticle = [...articles].reverse().find((a) => a.platform === TISTORY_PLATFORM) ?? null;
  let variantCreated = false;

  if (variantArticle) {
    const done = (await loadExistingPublications(variantArticle.id)).find((pub) => IN_PROGRESS_OR_DONE.includes(pub.status));
    if (done) {
      return { ok: true, publicationId: done.id, draftUrl: done.published_url ?? "", variantCreated: false, alreadyDone: true };
    }
  }

  const todayCount = await countToday(TISTORY_PLATFORM);
  if (todayCount >= TISTORY_CONFIG.dailyLimit) {
    return { ok: false, reason: "daily_limit", detail: `오늘 티스토리 발행이 상한(${TISTORY_CONFIG.dailyLimit})에 도달했습니다.` };
  }

  // 갓 생성한 배리에이션의 태그. articles에 metadata 컬럼이 없어 재사용 경로에서는 잃는다
  // (그때는 category 라벨로 폴백). 대부분은 첫 발행이라 배리에이션 태그(5~10개)를 그대로 쓴다.
  let freshTags: string[] = [];
  if (!variantArticle) {
    const result = await generateVariant({
      category: job.category,
      baseTitle: baseArticle.title ?? job.keyword,
      baseBody: baseArticle.content ?? "",
    });
    if (result.status !== "success") return { ok: false, reason: "variant_failed", detail: result.error };
    freshTags = result.variant.tags;
    variantArticle = await createVariantArticle({
      jobId,
      title: result.variant.title,
      content: result.variant.body,
      aiModel: baseArticle.ai_model,
    });
    variantCreated = true;
  }

  const bodyHtml = convertArticleToHtml(variantArticle.content ?? "");
  // 티스토리는 태그를 별도 입력란에 넣는다(§9-1, 자유 태그라 SEO에 유효). 배리에이션 태그를
  // 우선하고, 없으면(재사용 경로) category 라벨 하나로 폴백한다.
  const categoryFallback = job.category ? [BLOGSPOT_LABEL_BY_INTERNAL[job.category]].filter(Boolean) : [];
  const tags = freshTags.length > 0 ? freshTags : categoryFallback;

  const draftResult = await saveDraft({ title: variantArticle.title ?? job.keyword, bodyHtml, tags });
  if (!draftResult.ok) {
    // 로그인 만료는 "실패"가 아니라 "재로그인 대기"다 - publications에 failed를 남기지 않고,
    // 폴러가 deferred로 처리해 재시도 스팸을 막는다(카카오 세션이 짧아 자주 발생).
    if (draftResult.stage === "login") {
      return { ok: false, reason: "login_required", detail: draftResult.error };
    }
    await savePublication({ articleId: variantArticle.id, status: "failed", publishedUrl: null }).catch(() => {});
    return { ok: false, reason: "tistory_save_failed", detail: `[${draftResult.stage}] ${draftResult.error}`, stage: draftResult.stage };
  }

  const publication = await savePublication({
    articleId: variantArticle.id,
    status: "pending", // 임시저장 완료, 사람의 발행 클릭 대기(네이버와 동일)
    publishedUrl: draftResult.draftUrl,
  });

  return { ok: true, publicationId: publication.id, draftUrl: draftResult.draftUrl, variantCreated, alreadyDone: false };
}
