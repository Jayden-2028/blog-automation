// 승인된 job 1건을 Blogspot(Blogger)에 완전 자동 발행한다. SPRINT_5_DESIGN.md §4/§11.
//
// 흐름: job(approved) 확인 -> 기준 원고(platform=null) 로드 -> blogspot 배리에이션 원고 로드/생성
//   -> 일일 상한 확인 -> HTML 변환 -> BloggerClient.insertPost -> publications 기록.
//
// 멱등성: 배리에이션 article + platform='blogspot'로 이미 published/publishing/pending publication이
// 있으면 재발행하지 않고 그 기록을 돌려준다. 배리에이션 원고 자체도 이미 있으면 다시 만들지 않는다
// (LLM 비용 재지출 방지).
//
// 완전 자동이라 실패를 삼키지 않는다 - 모든 실패 경로가 publications.status='failed' 기록 +
// 구조화된 reason을 남긴다.

import { BLOGGER_CONFIG, BLOGSPOT_LABEL_BY_INTERNAL } from "../../config/publishTargets.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import { convertArticleToHtml } from "../../services/publish/convertArticleToHtml.js";
import {
  createArticle,
  listArticlesByJobId,
  updateArticleStatus,
} from "../../services/supabase/repositories/articleRepository.js";
import {
  countTodayPublicationsByPlatform,
  createPublication,
  listPublicationsByArticleId,
} from "../../services/supabase/repositories/publicationRepository.js";
import { generateArticleVariant } from "../writing/generateArticleVariant.js";
import type { GenerateArticleVariantResult } from "../writing/generateArticleVariant.js";
import type { BloggerInsertInput, BloggerInsertResult } from "../../services/publish/blogger/BloggerClient.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

export const BLOGSPOT_PLATFORM = "blogspot";

const IN_PROGRESS_OR_DONE: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishArticleToBlogspotResult =
  | { ok: true; publicationId: number; url: string; isDraft: boolean; variantCreated: boolean; alreadyDone: boolean }
  | { ok: false; reason: "disabled"; detail: string }
  | { ok: false; reason: "job_not_found" | "job_not_approved" | "base_article_not_found"; detail: string }
  | { ok: false; reason: "daily_limit"; detail: string }
  | { ok: false; reason: "variant_failed"; detail: string }
  | { ok: false; reason: "blogger_failed"; detail: string; stage: string };

export type PublishArticleToBlogspotOptions = {
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  createVariantArticle?: (input: {
    jobId: string;
    title: string;
    content: string;
    aiModel: string | null;
  }) => Promise<ArticleRow>;
  loadExistingPublications?: (articleId: number) => Promise<PublicationRow[]>;
  savePublication?: (input: {
    articleId: number;
    status: PublicationRow["status"];
    publishedUrl: string | null;
  }) => Promise<PublicationRow>;
  countToday?: (platform: string) => Promise<number>;
  generateVariant?: (input: {
    category: string | null;
    baseTitle: string;
    baseBody: string;
  }) => Promise<GenerateArticleVariantResult>;
  insertPost?: (input: BloggerInsertInput) => Promise<BloggerInsertResult>;
  /** enabled override (테스트). 생략하면 BLOGGER_CONFIG.enabled. */
  enabled?: boolean;
};

export async function publishArticleToBlogspot(
  jobId: string,
  options: PublishArticleToBlogspotOptions = {}
): Promise<PublishArticleToBlogspotResult> {
  const enabled = options.enabled ?? BLOGGER_CONFIG.enabled;
  if (!enabled) {
    return { ok: false, reason: "disabled", detail: "BLOGGER_ENABLED=false (또는 refresh token 미설정)" };
  }

  const loadJob = options.loadJob ?? ((id) => ArticleJobRepository.findById(id));
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const createVariantArticle =
    options.createVariantArticle ??
    (({ jobId: jid, title, content, aiModel }) =>
      createArticle({ job_id: jid, title, content, status: "approved", ai_model: aiModel, platform: BLOGSPOT_PLATFORM }));
  const loadExistingPublications = options.loadExistingPublications ?? listPublicationsByArticleId;
  const savePublication =
    options.savePublication ??
    (({ articleId, status, publishedUrl }) =>
      createPublication({ article_id: articleId, platform: BLOGSPOT_PLATFORM, status, published_url: publishedUrl }));
  const countToday = options.countToday ?? countTodayPublicationsByPlatform;
  const generateVariant =
    options.generateVariant ??
    ((input) => generateArticleVariant({ channel: "blogspot", ...input }));
  const insertPost = options.insertPost ?? ((input) => new BloggerClient().insertPost(input));

  const job = await loadJob(jobId);
  if (!job) return { ok: false, reason: "job_not_found", detail: `job을 찾을 수 없습니다: ${jobId}` };
  if (job.status !== "approved") {
    return { ok: false, reason: "job_not_approved", detail: `job 상태가 approved가 아닙니다 (현재: ${job.status})` };
  }

  const articles = await loadArticles(jobId);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) {
    return { ok: false, reason: "base_article_not_found", detail: `job에 연결된 기준 원고가 없습니다: ${jobId}` };
  }

  // 이미 만들어 둔 배리에이션이 있으면 재사용(LLM 재지출 방지).
  let variantArticle = [...articles].reverse().find((a) => a.platform === BLOGSPOT_PLATFORM) ?? null;
  let variantCreated = false;

  // 배리에이션이 이미 발행됐는지 멱등성 확인.
  if (variantArticle) {
    const existing = await loadExistingPublications(variantArticle.id);
    const done = existing.find((pub) => IN_PROGRESS_OR_DONE.includes(pub.status));
    if (done) {
      return {
        ok: true,
        publicationId: done.id,
        url: done.published_url ?? "",
        isDraft: BLOGGER_CONFIG.publishAsDraft,
        variantCreated: false,
        alreadyDone: true,
      };
    }
  }

  // 일일 상한(하드 가드). 배리에이션 생성 전에 확인해 LLM 비용도 아낀다.
  const todayCount = await countToday(BLOGSPOT_PLATFORM);
  if (todayCount >= BLOGGER_CONFIG.dailyLimit) {
    return {
      ok: false,
      reason: "daily_limit",
      detail: `오늘 Blogspot 발행이 상한(${BLOGGER_CONFIG.dailyLimit})에 도달했습니다. 다음 폴링에서 재시도합니다.`,
    };
  }

  if (!variantArticle) {
    const result = await generateVariant({
      category: job.category,
      baseTitle: baseArticle.title ?? job.keyword,
      baseBody: baseArticle.content ?? "",
    });
    if (result.status !== "success") {
      return { ok: false, reason: "variant_failed", detail: result.error };
    }
    variantArticle = await createVariantArticle({
      jobId,
      title: result.variant.title,
      content: result.variant.body,
      aiModel: baseArticle.ai_model,
    });
    variantCreated = true;
  }

  const contentHtml = convertArticleToHtml(variantArticle.content ?? "");
  const label = job.category ? BLOGSPOT_LABEL_BY_INTERNAL[job.category] : undefined;

  const inserted = await insertPost({
    title: variantArticle.title ?? job.keyword,
    contentHtml,
    labels: label ? [label] : undefined,
    isDraft: BLOGGER_CONFIG.publishAsDraft,
  });

  if (!inserted.ok) {
    await savePublication({ articleId: variantArticle.id, status: "failed", publishedUrl: null }).catch(() => {});
    return { ok: false, reason: "blogger_failed", detail: `[${inserted.stage}] ${inserted.error}`, stage: inserted.stage };
  }

  const publication = await savePublication({
    articleId: variantArticle.id,
    status: inserted.isDraft ? "pending" : "published",
    publishedUrl: inserted.url,
  });
  // 공개 발행이면 배리에이션 원고 상태도 published로 올린다(기준 원고와 별개). draft면 pending 유지.
  if (!inserted.isDraft) {
    await updateArticleStatus(variantArticle.id, "published").catch(() => {});
  }

  return {
    ok: true,
    publicationId: publication.id,
    url: inserted.url,
    isDraft: inserted.isDraft,
    variantCreated,
    alreadyDone: false,
  };
}
