// 승인된 원고 1건을 **네이버 블로그에 실제 발행**한다(2026-09-22 네이버 운영 재개).
//
// 왜 services/publish/publishArticleToNaver.ts를 안 쓰고 새로 만드는가: 그 파일은 2026-08 스프린트
// 설계라 (a) 기준 원고를 그대로 올리고 (b) 이미지를 `images` 테이블에서 읽으며 (c) 임시저장까지만
// 한다. 지금 파이프라인은 셋 다 다르다 - 배리에이션을 올리고, 이미지는 job.metadata.images에 있고,
// 사용자 결정으로 임시저장 없이 바로 발행한다. 옛 파일은 손대지 않고 그대로 둔다(되돌릴 여지).
//
// Blogspot 경로(publishArticleToBlogspot.ts)와 나란히 놓고 보면 다른 점은 셋뿐이다:
//   1. 배리에이션이 다르다 - generateNaverVariant(참고 자료 링크아웃을 뺀 가벼운 재작성)
//   2. HTML 변환기가 다르다 - convertArticleToNaverHtml(SmartEditor paste용)
//   3. 발행 수단이 다르다 - 공식 API가 없어 Playwright로 로그인된 브라우저를 조작한다
// 이미지는 **같은 것을 쓴다**(사용자 결정) - job.metadata.images를 그대로 읽는다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { createArticle, listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import {
  createPublication,
  listPublicationsByArticleIds,
} from "../../services/supabase/repositories/publicationRepository.js";
import { convertArticleToNaverHtml } from "../../services/publish/convertArticleToNaverHtml.js";
import { NaverBlogPublisher } from "../../services/publish/NaverBlogPublisher.js";
import type { NaverDraftSaveResult, NaverVisibility } from "../../services/publish/NaverBlogPublisher.js";
import { naverCategoryNo } from "../../config/naverCategoryMapping.js";
import { generateNaverVariant } from "../writing/generateNaverVariant.js";
import type { GenerateNaverVariantResult } from "../writing/generateNaverVariant.js";
import {
  manuscriptBodyWithoutImages,
  substituteConfirmedImages,
} from "../manuscripts/parseManuscriptBlocks.js";
import { readJobManuscriptImages } from "../manuscripts/manuscriptManifest.js";
import { BLOGSPOT_PLATFORM } from "../manuscripts/prepareManuscript.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

export const NAVER_PLATFORM = "naver";

/** 이 상태의 publication이 있으면 이미 올라간 것으로 보고 다시 올리지 않는다. */
const IN_PROGRESS_OR_DONE: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishJobToNaverResult =
  | { ok: true; publicationId: number; url: string; variantCreated: boolean; alreadyDone: boolean }
  | { ok: false; reason: "job_not_found" | "job_not_approved" | "base_article_not_found" | "variant_failed" | "naver_failed"; detail: string };

export type PublishJobToNaverOptions = {
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  loadJobPublications?: (articleIds: number[]) => Promise<PublicationRow[]>;
  createVariantArticle?: (input: { jobId: string; title: string; content: string; aiModel: string | null }) => Promise<ArticleRow>;
  savePublication?: (input: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) => Promise<PublicationRow>;
  generateVariant?: (input: { category: string | null; blogspotTitle: string; blogspotBody: string }) => Promise<GenerateNaverVariantResult>;
  /** NaverBlogPublisher.publish와 같은 시그니처. 테스트에서 브라우저 대신 가짜 결과를 준다. */
  publish?: (
    input: { title: string; bodyHtml: string },
    visibility: NaverVisibility,
    categoryNo: number
  ) => Promise<NaverDraftSaveResult>;
  /**
   * 공개 범위. 첫 운영은 비공개로 돌려 결과를 눈으로 확인한 뒤 공개로 올린다(사용자 결정).
   * 환경변수 NAVER_PUBLISH_VISIBILITY=public 으로 바꾼다.
   */
  visibility?: NaverVisibility;
};

function resolveVisibility(explicit?: NaverVisibility): NaverVisibility {
  if (explicit) return explicit;
  // 기본값을 비공개로 둔다 - 잘못 켜졌을 때 조용히 공개되는 쪽보다 안 보이는 쪽이 낫다.
  return process.env.NAVER_PUBLISH_VISIBILITY === "public" ? "public" : "private";
}

export async function publishJobToNaver(
  jobId: string,
  options: PublishJobToNaverOptions = {}
): Promise<PublishJobToNaverResult> {
  const loadJob = options.loadJob ?? ((id) => ArticleJobRepository.findById(id));
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const loadJobPublications = options.loadJobPublications ?? listPublicationsByArticleIds;
  const createVariantArticle =
    options.createVariantArticle ??
    ((input) =>
      createArticle({
        job_id: input.jobId,
        title: input.title,
        content: input.content,
        status: "approved",
        ai_model: input.aiModel,
        platform: NAVER_PLATFORM,
      }));
  const savePublication =
    options.savePublication ??
    ((input) =>
      createPublication({
        article_id: input.articleId,
        platform: NAVER_PLATFORM,
        status: input.status,
        published_url: input.publishedUrl,
      }));
  const generateVariant = options.generateVariant ?? generateNaverVariant;
  const visibility = resolveVisibility(options.visibility);

  const job = await loadJob(jobId);
  if (!job) return { ok: false, reason: "job_not_found", detail: `job을 찾을 수 없습니다: ${jobId}` };
  if (job.status !== "approved") {
    return { ok: false, reason: "job_not_approved", detail: `job 상태가 approved가 아닙니다(현재: ${job.status}).` };
  }

  const articles = await loadArticles(jobId);

  // 이 job이 네이버에 이미 올라갔는지 **job 전체**로 본다 - 수정 반영이 들어오면 article row가
  // 새로 생겨서, 한 건만 보면 "아직 안 올렸다"로 읽히고 같은 글이 두 번 올라간다.
  const publications = await loadJobPublications(articles.map((article) => article.id));
  const done = publications.find(
    (pub) => pub.platform === NAVER_PLATFORM && IN_PROGRESS_OR_DONE.includes(pub.status)
  );
  if (done) {
    return {
      ok: true,
      publicationId: done.id,
      url: done.published_url ?? "",
      variantCreated: false,
      alreadyDone: true,
    };
  }

  // 네이버 배리에이션은 **네이버 발행을 누른 순간에만** 만든다. 원고마다 미리 만들어 두면 쓰지도
  // 않을 LLM 비용이 매번 나간다(2026-09-21에 NAVER_VARIANT_ENABLED로 꺼둔 이유가 그것이다).
  let variant = [...articles].reverse().find((article) => article.platform === NAVER_PLATFORM) ?? null;
  let variantCreated = false;
  if (!variant) {
    // 원본은 Blogspot 배리에이션이다 - 중복 판정의 상대가 바로 그 글이라 그것을 보고 달라져야 한다.
    const source =
      [...articles].reverse().find((article) => article.platform === BLOGSPOT_PLATFORM) ??
      [...articles].reverse().find((article) => article.platform == null);
    if (!source) {
      return { ok: false, reason: "base_article_not_found", detail: `job에 연결된 원고가 없습니다: ${jobId}` };
    }

    const result = await generateVariant({
      category: job.category ?? null,
      blogspotTitle: source.title ?? job.keyword,
      blogspotBody: source.content ?? "",
    });
    if (result.status !== "success") {
      return { ok: false, reason: "variant_failed", detail: `네이버 배리에이션 생성 실패: ${result.error}` };
    }
    variant = await createVariantArticle({
      jobId: job.id,
      title: result.variant.title,
      content: result.variant.body,
      aiModel: source.ai_model,
    });
    variantCreated = true;
  }

  // 이미지는 Blogspot과 **같은 것**을 쓴다(사용자 결정). 확정된 이미지만 마커 자리에 끼워 넣고,
  // 남은 마커는 지운다 - 공개 발행이라 `[IMAGE: ... — 웹 검색]` 글자가 독자에게 보이면 안 된다.
  const confirmedImages = readJobManuscriptImages(job);
  const bodyWithImages = substituteConfirmedImages(variant.content ?? "", confirmedImages);
  const bodyHtml = convertArticleToNaverHtml(manuscriptBodyWithoutImages(bodyWithImages));

  const categoryNo = naverCategoryNo(job.category);
  const publish =
    options.publish ??
    ((input, vis, category) =>
      new NaverBlogPublisher({
        categoryNo: category,
        // 본문 붙여넣기가 실제 OS 클립보드 + Cmd+V를 쓴다 - headless에서는 클립보드가 없어
        // 본문이 통째로 비는 것을 2026-09-22 실측으로 확인했다. 창을 띄워야 한다.
        headless: false,
      }).publish(input, vis));

  const result = await publish({ title: variant.title ?? job.keyword, bodyHtml }, visibility, categoryNo);

  if (!result.ok) {
    // 실패도 기록한다 - 조용히 죽는 job을 만들지 않는다.
    await savePublication({ articleId: variant.id, status: "failed", publishedUrl: null }).catch(() => {});
    return { ok: false, reason: "naver_failed", detail: `[${result.stage}] ${result.error}` };
  }

  const publication = await savePublication({
    articleId: variant.id,
    status: "published",
    publishedUrl: result.draftUrl,
  });

  return { ok: true, publicationId: publication.id, url: result.draftUrl, variantCreated, alreadyDone: false };
}
