// 승인된 원고 1건을 **티스토리에 실제 발행**한다(TISTORY_AUTO_PUBLISH_DESIGN.md). publishJobToNaver.ts의
// 티스토리 판 - 오케스트레이션은 같고 변환기·발행 수단만 다르다.
//
// 발행하는 글은 작성 단계 원고(=최종 원고, pickFinalArticle) 그대로다. 뷰어에서 "📤 수정본 반영"을 누른 수정은
// articles.content에 먼저 쓰이므로(applyViewerEditRequest.ts) 여기서 별도 처리 없이 반영된다.
//
// 사회 트랙 전용 가공:
//   - `참고 자료` 링크아웃은 **남긴다**(티스토리는 바깥 링크가 문제 없다. 네이버만 뺀다).
//   - Blogspot 내부 링크 "함께 보면 좋은 글"은 **뺀다**(다른 블로그로 가는 링크).
//   - 이미지는 Blogspot·네이버와 **같은 것**(job.metadata.images)을 쓰고, 본문에는 표식만 두고 발행기가 업로드한다.
//   - 본문 맨 아래 **해시태그 줄은 뺀다**(2026-10-06 사용자 결정, 엔터·네이버는 유지). 태그는 그 줄에서 뽑아 태그 입력으로만 넣는다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import {
  createPublication,
  listPublicationsByArticleIds,
} from "../../services/supabase/repositories/publicationRepository.js";
import { convertArticleToTistoryHtml } from "../../services/publish/convertArticleToTistoryHtml.js";
import { TistoryPublisher } from "../../services/publish/tistory/TistoryPublisher.js";
import type {
  TistoryPublishImageInput,
  TistoryPublishInput,
  TistoryPublishResult,
  TistoryVisibility,
} from "../../services/publish/tistory/TistoryPublisher.js";
import { TISTORY_CONFIG } from "../../config/publishTargets.js";
import { tistoryCategoryName } from "../../config/tistoryCategoryMapping.js";
import { manuscriptBodyWithoutImages, substituteConfirmedImages } from "../manuscripts/parseManuscriptBlocks.js";
import { readJobManuscriptImages } from "../manuscripts/manuscriptManifest.js";
import { pickFinalArticle } from "../manuscripts/pickFinalArticle.js";
import { removeRelatedPosts } from "../manuscripts/appendRelatedPosts.js";
import { splitTrailingHashtags } from "../manuscripts/articleContentParts.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

export const TISTORY_PLATFORM = "tistory";

const IN_PROGRESS_OR_DONE: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishJobToTistoryResult =
  | { ok: true; publicationId: number; url: string; alreadyDone: boolean; warnings?: string[] }
  /** 로그인이 풀렸다 - 실패가 아니라 **대기**다. 폴러가 deferred로 기록하고 재로그인 후 다시 시도한다. */
  | { ok: false; reason: "login_required"; detail: string }
  | { ok: false; reason: "disabled" | "job_not_found" | "job_not_approved" | "base_article_not_found" | "tistory_failed"; detail: string };

export type PublishJobToTistoryOptions = {
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  loadJobPublications?: (articleIds: number[]) => Promise<PublicationRow[]>;
  savePublication?: (input: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) => Promise<PublicationRow>;
  /** TistoryPublisher.publish와 같은 시그니처. 테스트에서 브라우저 대신 가짜 결과를 준다. */
  publish?: (input: TistoryPublishInput, visibility: TistoryVisibility) => Promise<TistoryPublishResult>;
  visibility?: TistoryVisibility;
  enabled?: boolean;
};

/** 태그는 writer frontmatter(job.metadata.draftMeta.tags) 우선, 없으면 본문 끝 해시태그 줄에서 뽑는다. 최대 10개. */
export function tistoryTagsFor(job: ArticleJobRow, content: string): string[] {
  const draftMeta = (job.metadata as Record<string, unknown> | null)?.draftMeta as { tags?: unknown } | undefined;
  const fromMeta = Array.isArray(draftMeta?.tags)
    ? draftMeta!.tags.filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "").trim()).filter(Boolean)
    : [];
  const tags = fromMeta.length > 0 ? fromMeta : splitTrailingHashtags(content).tags;
  return [...new Set(tags)].slice(0, 10);
}

export async function publishJobToTistory(
  jobId: string,
  options: PublishJobToTistoryOptions = {}
): Promise<PublishJobToTistoryResult> {
  const enabled = options.enabled ?? TISTORY_CONFIG.enabled;
  if (!enabled) return { ok: false, reason: "disabled", detail: "TISTORY_ENABLED가 꺼져 있습니다." };

  const loadJob = options.loadJob ?? ((id) => ArticleJobRepository.findById(id));
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const loadJobPublications = options.loadJobPublications ?? listPublicationsByArticleIds;
  const savePublication =
    options.savePublication ??
    ((input) =>
      createPublication({
        article_id: input.articleId,
        platform: TISTORY_PLATFORM,
        status: input.status,
        published_url: input.publishedUrl,
      }));
  const visibility = options.visibility ?? TISTORY_CONFIG.visibility;

  const job = await loadJob(jobId);
  if (!job) return { ok: false, reason: "job_not_found", detail: `job을 찾을 수 없습니다: ${jobId}` };
  if (job.status !== "approved") {
    return { ok: false, reason: "job_not_approved", detail: `job 상태가 approved가 아닙니다(현재: ${job.status}).` };
  }

  const articles = await loadArticles(jobId);
  // job 전체로 본다 - 수정 반영으로 article row가 새로 생겨도 같은 글을 두 번 올리지 않는다(네이버와 같다).
  const publications = await loadJobPublications(articles.map((article) => article.id));
  const done = publications.find((pub) => pub.platform === TISTORY_PLATFORM && IN_PROGRESS_OR_DONE.includes(pub.status));
  if (done) return { ok: true, publicationId: done.id, url: done.published_url ?? "", alreadyDone: true };

  const picked = pickFinalArticle(articles);
  if (!picked) return { ok: false, reason: "base_article_not_found", detail: `job에 연결된 원고가 없습니다: ${jobId}` };
  const article = picked.final;

  const confirmedImages = readJobManuscriptImages(job);
  const content = article.content ?? "";
  // 태그는 해시태그 줄을 떼기 **전** 본문에서 뽑는다(아래 tags) - 본문에서는 그 줄을 지운다.
  const bodyWithoutHashtags = splitTrailingHashtags(content).body;
  const bodyWithImages = substituteConfirmedImages(removeRelatedPosts(bodyWithoutHashtags), confirmedImages);
  const { html: bodyHtml, images } = convertArticleToTistoryHtml(manuscriptBodyWithoutImages(bodyWithImages));
  const imageInputs: TistoryPublishImageInput[] = images.map((image) => ({ url: image.url, alt: image.alt, marker: image.marker }));

  const publish = options.publish ?? ((input, vis) => new TistoryPublisher().publish(input, vis));
  const result = await publish(
    {
      title: article.title ?? job.keyword,
      bodyHtml,
      images: imageInputs,
      tags: tistoryTagsFor(job, content),
      categoryName: tistoryCategoryName(job.category),
    },
    visibility
  );

  if (!result.ok) {
    if (result.stage === "login") return { ok: false, reason: "login_required", detail: result.error };
    await savePublication({ articleId: article.id, status: "failed", publishedUrl: null }).catch(() => {});
    return { ok: false, reason: "tistory_failed", detail: `[${result.stage}] ${result.error}` };
  }

  const publication = await savePublication({ articleId: article.id, status: "published", publishedUrl: result.url });
  return { ok: true, publicationId: publication.id, url: result.url, alreadyDone: false, warnings: result.warnings };
}
