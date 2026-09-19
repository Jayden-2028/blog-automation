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
//
// 2026-09-15 재배선(BLOGSPOT_ONLY_DESIGN.md 이후 원고 파이프라인과 맞추기 - 아직 BLOGGER_ENABLED는
// 켜지 않았다, 코드만 준비): 이 함수는 원래 prepareManuscript.ts보다 먼저 있던 반자동 업로드 경로의
// 잔재라, 09-05 이후 도입된 두 가지를 몰랐다.
// 1) searchDescription: 배리에이션을 새로 안 만들고 재사용하는 경로(articles 테이블에 이미
//    platform='blogspot' 행이 있음)에서는 검색 설명을 못 구했다 - prepareManuscript.ts처럼
//    job.metadata.channelMeta.blogspot에서 복구한다.
// 2) 이미지: 원고 본문(articles.content)에는 여전히 `[IMAGE: 설명]` 마커 텍스트만 있고, 실제
//    생성된 이미지 URL은 job.metadata.images(prepareManuscript.ts가 저장)에 따로 있다 - HTML
//    변환 전에 substituteConfirmedImages로 마커를 실제 `![설명](url)`로 바꿔 넣는다. A/B 비교로
//    후보가 2장이라 아직 사람이 고르지 않았으면(또는 전부 실패했으면) 마커를 그대로 둔다.

import { BLOGGER_CONFIG, BLOGSPOT_LABEL_BY_INTERNAL } from "../../config/publishTargets.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import type { BloggerPublishResult } from "../../services/publish/blogger/BloggerClient.js";
import { convertArticleToHtml } from "../../services/publish/convertArticleToHtml.js";
import {
  createArticle,
  listArticlesByJobId,
  updateArticleStatus,
} from "../../services/supabase/repositories/articleRepository.js";
import {
  countTodayPublicationsByPlatform,
  createPublication,
  listPublicationsByArticleIds,
  updatePublicationStatus,
} from "../../services/supabase/repositories/publicationRepository.js";
import { generateArticleVariant } from "../writing/generateArticleVariant.js";
import type { GenerateArticleVariantResult } from "../writing/generateArticleVariant.js";
import { readJobManuscriptImages } from "../manuscripts/manuscriptManifest.js";
import { manuscriptBodyWithoutImages, substituteConfirmedImages } from "../manuscripts/parseManuscriptBlocks.js";
import type {
  BloggerInsertInput,
  BloggerInsertResult,
  BloggerUpdateInput,
  BloggerUpdateResult,
} from "../../services/publish/blogger/BloggerClient.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

export const BLOGSPOT_PLATFORM = "blogspot";

/** prepareManuscript.ts가 신규 생성 시 job.metadata.channelMeta.blogspot에 저장하는 형태. */
type ChannelMetaEntry = { searchDescription: string | null; slug: string | null; tags: string[] };
type ChannelMetaMap = Record<string, ChannelMetaEntry>;

const IN_PROGRESS_OR_DONE: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishArticleToBlogspotResult =
  | {
      ok: true;
      publicationId: number;
      url: string;
      isDraft: boolean;
      variantCreated: boolean;
      alreadyDone: boolean;
      /** 새 글을 올린 게 아니라 **이미 있던 글의 본문을 지금 원고로 덮어썼다**(수정 반영). */
      updatedExisting?: boolean;
    }
  | { ok: false; reason: "disabled"; detail: string }
  | { ok: false; reason: "job_not_found" | "job_not_approved" | "base_article_not_found"; detail: string }
  | { ok: false; reason: "daily_limit"; detail: string }
  | { ok: false; reason: "variant_failed"; detail: string }
  | { ok: false; reason: "blogger_failed"; detail: string; stage: string };

export type PublishArticleToBlogspotOptions = {
  /** 테스트 주입: 초안 -> 공개 전환(posts.publish). 기본은 BloggerClient.publishPost. */
  publishPost?: (postId: string) => Promise<BloggerPublishResult>;
  /** 테스트 주입: 초안 본문을 공개용으로 덮어쓰기(posts.patch). 기본은 BloggerClient.updatePost. */
  updatePost?: (postId: string, input: BloggerUpdateInput) => Promise<BloggerUpdateResult>;
  /** 테스트 주입: 공개 URL 경로로 postId 되찾기. 기본은 BloggerClient.getPostIdByPath. */
  findPostIdByPath?: (path: string) => Promise<string | null>;
  /** 테스트 주입: job에 속한 article 전부의 publication 조회. 기본은 Supabase. */
  loadJobPublications?: (articleIds: number[]) => Promise<PublicationRow[]>;
  /**
   * 초안이냐 공개냐를 호출부가 정한다(2026-09-19). 생략하면 BLOGGER_CONFIG.publishAsDraft(기본 true).
   *
   * 왜 필요한가: 원고 준비 완료 알림의 **발행 버튼**은 사용자가 이미지까지 반영된 최종 원고를 보고
   * 누르는 것이라 그 호출만 공개(false)여야 한다. 전역 기본값을 뒤집으면 자동 폴링 경로까지 공개로
   * 바뀌어 사람이 안 본 원고가 나간다.
   */
  asDraft?: boolean;
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  createVariantArticle?: (input: {
    jobId: string;
    title: string;
    content: string;
    aiModel: string | null;
  }) => Promise<ArticleRow>;
  savePublication?: (input: {
    articleId: number;
    status: PublicationRow["status"];
    publishedUrl: string | null;
  }) => Promise<PublicationRow>;
  countToday?: (platform: string) => Promise<number>;
  /**
   * 발행 성공을 DB에 반영한다(publications.status/URL + articles.status). 테스트 주입 지점 -
   * 없으면 이 함수가 Supabase를 직접 친다.
   */
  markPublished?: (input: { publicationId: number; url: string; articleId: number }) => Promise<void>;
  generateVariant?: (input: {
    category: string | null;
    baseTitle: string;
    baseBody: string;
  }) => Promise<GenerateArticleVariantResult>;
  insertPost?: (input: BloggerInsertInput) => Promise<BloggerInsertResult>;
  /** enabled override (테스트). 생략하면 BLOGGER_CONFIG.enabled. */
  enabled?: boolean;
};

/**
 * 초안 편집 URL에서 postId를 뽑는다: `https://www.blogger.com/blog/post/edit/{blogId}/{postId}`.
 * publications 테이블에 postId 컬럼이 없어(마이그레이션은 승인 게이트) URL에서 읽는다.
 */
export function extractPostId(url: string | null | undefined): string | null {
  if (!url) return null;
  const matched = url.match(/\/post\/edit\/\d+\/(\d+)/);
  return matched ? matched[1] : null;
}

/** 공개 URL에서 blog 경로만 뽑는다(posts.getByPath용): .../2026/09/x.html -> /2026/09/x.html */
function urlPath(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

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
  const savePublication =
    options.savePublication ??
    (({ articleId, status, publishedUrl }) =>
      createPublication({ article_id: articleId, platform: BLOGSPOT_PLATFORM, status, published_url: publishedUrl }));
  const countToday = options.countToday ?? countTodayPublicationsByPlatform;
  const generateVariant = options.generateVariant ?? ((input) => generateArticleVariant(input));
  const insertPost = options.insertPost ?? ((input) => new BloggerClient().insertPost(input));
  const publishPost = options.publishPost ?? ((postId: string) => new BloggerClient().publishPost(postId));
  const updatePost =
    options.updatePost ?? ((postId: string, input: BloggerUpdateInput) => new BloggerClient().updatePost(postId, input));
  const findPostIdByPath = options.findPostIdByPath ?? ((path: string) => new BloggerClient().getPostIdByPath(path));
  const loadJobPublications = options.loadJobPublications ?? listPublicationsByArticleIds;
  const markPublished =
    options.markPublished ??
    (async ({ publicationId, url, articleId }) => {
      await updatePublicationStatus(publicationId, "published", url).catch(() => {});
      await updateArticleStatus(articleId, "published").catch(() => {});
    });

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

  const label = job.category ? BLOGSPOT_LABEL_BY_INTERNAL[job.category] : undefined;

  /**
   * 발행할 본문 HTML을 만든다. prepareManuscript.ts가 job.metadata.images에 저장해 둔 이미지를
   * 본문의 [IMAGE: 설명] 마커 자리에 확정된 것만(정확히 1장) 끼워 넣는다.
   *
   * 채워지지 않고 남은 마커(주로 `— 웹 검색` 자리)는 **초안이냐 공개냐**로 갈린다.
   *  - 초안: 그대로 둔다. 편집 화면에서 "여기에 자료를 넣어라"는 TODO 표시로 쓰인다.
   *  - 공개: **반드시 지운다.** 안 지우면 `[IMAGE: ... — 웹 검색]`이라는 글자가 독자에게 그대로
   *    보인다(convertArticleToHtml의 placeholder 경로가 <p>로 렌더한다).
   */
  const buildContentHtml = (article: ArticleRow, draft: boolean): string => {
    const confirmedImages = readJobManuscriptImages(job);
    const bodyWithImages = substituteConfirmedImages(article.content ?? "", confirmedImages);
    return convertArticleToHtml(draft ? bodyWithImages : manuscriptBodyWithoutImages(bodyWithImages));
  };

  // 이미 만들어 둔 배리에이션이 있으면 재사용(LLM 재지출 방지).
  let variantArticle = [...articles].reverse().find((a) => a.platform === BLOGSPOT_PLATFORM) ?? null;
  let variantCreated = false;

  // 이 job의 원고가 블로그에 이미 올라가 있는지 확인한다. **article 한 건이 아니라 job 전체**를
  // 본다(2026-09-19): 수정 반영이 들어오면 배리에이션 article row가 새로 생기는데, 그 row만 보면
  // publication이 없어 "아직 안 올렸다"로 보이고 같은 글이 블로그에 두 번 올라간다.
  const publications = await loadJobPublications(articles.map((article) => article.id));
  const done = publications.find((pub) => IN_PROGRESS_OR_DONE.includes(pub.status));
  if (done) {
    const wantsPublic = (options.asDraft ?? BLOGGER_CONFIG.publishAsDraft) === false;
    // 초안은 편집 URL에 postId가 들어 있다. 공개된 글은 주소만 남아 있어 경로로 되찾는다.
    const postId = extractPostId(done.published_url) ?? (await findPostIdByPath(urlPath(done.published_url)).catch(() => null));

    // 덮어쓸 상황인가:
    //  - 공개 요청인데 아직 초안이다  -> 공개용 본문으로 덮어쓴 뒤 공개 전환(posts.publish).
    //    초안 본문은 "초안 모드"로 만들어져 채워지지 않은 마커가 글자 그대로 남아 있다.
    //  - 이미 공개된 글이다          -> 지금 원고(수정 반영본일 수 있다)로 본문을 갱신한다.
    const shouldRefresh = Boolean(postId) && Boolean(variantArticle) && (done.status === "published" || (wantsPublic && done.status === "pending"));

    if (postId && variantArticle && shouldRefresh) {
      const refreshed = await updatePost(postId, {
        title: variantArticle.title ?? job.keyword,
        contentHtml: buildContentHtml(variantArticle, false),
        labels: label ? [label] : undefined,
      });
      if (!refreshed.ok) {
        return { ok: false, reason: "blogger_failed", detail: `[${refreshed.stage}] ${refreshed.error}`, stage: refreshed.stage };
      }

      if (done.status === "pending") {
        const promoted = await publishPost(postId);
        if (!promoted.ok) {
          return { ok: false, reason: "blogger_failed", detail: `[${promoted.stage}] ${promoted.error}`, stage: promoted.stage };
        }
        await markPublished({ publicationId: done.id, url: promoted.url, articleId: variantArticle.id });
        return { ok: true, publicationId: done.id, url: promoted.url, isDraft: false, variantCreated: false, alreadyDone: false };
      }

      // 이미 공개돼 있던 글이다 - 주소는 그대로고 본문만 바뀐다.
      await markPublished({ publicationId: done.id, url: done.published_url ?? "", articleId: variantArticle.id });
      return {
        ok: true,
        publicationId: done.id,
        url: done.published_url ?? "",
        isDraft: false,
        variantCreated: false,
        alreadyDone: false,
        updatedExisting: true,
      };
    }

    return {
      ok: true,
      publicationId: done.id,
      url: done.published_url ?? "",
      isDraft: done.status === "pending",
      variantCreated: false,
      alreadyDone: true,
    };
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

  // articles 테이블엔 searchDescription 컬럼이 없다 - prepareManuscript.ts와 같은 자리
  // (job.metadata.channelMeta.blogspot)에서 복구한다. 재사용 경로(이미 배리에이션이 있음)는 여기서
  // 채워지고, 신규 생성 경로는 아래에서 방금 만든 값으로 덮어쓴다.
  const channelMeta = (job.metadata?.channelMeta as ChannelMetaMap | undefined) ?? {};
  let searchDescription: string | null = channelMeta[BLOGSPOT_PLATFORM]?.searchDescription ?? null;

  if (!variantArticle) {
    const result = await generateVariant({
      category: job.category,
      baseTitle: baseArticle.title ?? job.keyword,
      baseBody: baseArticle.content ?? "",
    });
    if (result.status !== "success") {
      return { ok: false, reason: "variant_failed", detail: result.error };
    }
    searchDescription = result.variant.searchDescription;
    variantArticle = await createVariantArticle({
      jobId,
      title: result.variant.title,
      content: result.variant.body,
      aiModel: baseArticle.ai_model,
    });
    variantCreated = true;
  }

  const isDraft = options.asDraft ?? BLOGGER_CONFIG.publishAsDraft;
  const contentHtml = buildContentHtml(variantArticle, isDraft);

  const inserted = await insertPost({
    title: variantArticle.title ?? job.keyword,
    contentHtml,
    labels: label ? [label] : undefined,
    searchDescription,
    isDraft,
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
