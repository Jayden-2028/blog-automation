// 승인된 원고 1건을 네이버 블로그에 "임시저장"하는 오케스트레이션. SPRINT_4_DESIGN.md §10 item 5.
//
// runArticleJob.ts/rejectArticleJob.ts와 같은 위치의 워크플로 함수다 - DB 조회/기록은 여기서
// 하고, 실제 브라우저 조작(NaverBlogPublisher)과 HTML 변환(convertArticleToNaverHtml)은 각자
// 파일로 분리되어 있어 이 함수는 "무엇을 언제 부를지"만 담당한다.
//
// 재시도 멱등성(SPRINT_4_DESIGN.md §8): 같은 jobId로 두 번 실행해도 임시저장이 중복 생성되지
// 않는다 - publications에 이미 pending/published row가 있으면 그 기록을 그대로 돌려주고
// NaverBlogPublisher를 아예 호출하지 않는다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../supabase/repositories/articleRepository.js";
import { listImagesByArticleId } from "../supabase/repositories/imageRepository.js";
import { createPublication, listPublicationsByArticleId } from "../supabase/repositories/publicationRepository.js";
import { convertArticleToNaverHtml, stripImageMarkdownBlocks } from "./convertArticleToNaverHtml.js";
import { NaverBlogPublisher } from "./NaverBlogPublisher.js";
import type { NaverDraftSaveResult, NaverDraftSaveStage, NaverPublishImageInput } from "./NaverBlogPublisher.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

const PLATFORM = "naver";

/** 임시저장이 이미 진행/완료된 것으로 취급하는 상태 - 이 상태의 publications row가 있으면 재실행을 막는다. */
const IN_PROGRESS_OR_DONE_STATUSES: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishArticleToNaverOptions = {
  /** 테스트 주입 지점. 기본은 실제 ArticleJobRepository/articleRepository 등을 그대로 쓴다. */
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  loadImages?: (articleId: number) => Promise<ReadonlyArray<{ image_url: string | null; alt_text: string | null }>>;
  loadExistingPublications?: (articleId: number) => Promise<PublicationRow[]>;
  savePublication?: (input: {
    articleId: number;
    status: PublicationRow["status"];
    publishedUrl: string | null;
  }) => Promise<PublicationRow>;
  /** NaverBlogPublisher.saveDraft와 동일한 시그니처. 실제 브라우저 대신 가짜 결과를 주입할 때 쓴다. */
  saveDraft?: (input: {
    title: string;
    bodyHtml: string;
    images?: ReadonlyArray<NaverPublishImageInput>;
  }) => Promise<NaverDraftSaveResult>;
};

export type PublishArticleToNaverResult =
  | { ok: true; publicationId: number; draftUrl: string; imageCount: number; alreadyDone: false }
  | { ok: true; publicationId: number; draftUrl: string; imageCount: 0; alreadyDone: true }
  | { ok: false; reason: "job_not_found"; detail: string }
  | { ok: false; reason: "job_not_approved"; detail: string }
  | { ok: false; reason: "article_not_found"; detail: string }
  | { ok: false; reason: "naver_save_failed"; detail: string; stage: NaverDraftSaveStage };

export async function publishArticleToNaver(
  jobId: string,
  options: PublishArticleToNaverOptions = {}
): Promise<PublishArticleToNaverResult> {
  const loadJob = options.loadJob ?? ((id) => ArticleJobRepository.findById(id));
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const loadImages = options.loadImages ?? listImagesByArticleId;
  const loadExistingPublications = options.loadExistingPublications ?? listPublicationsByArticleId;
  const savePublication =
    options.savePublication ??
    (({ articleId, status, publishedUrl }) =>
      createPublication({ article_id: articleId, platform: PLATFORM, status, published_url: publishedUrl }));
  const saveDraft =
    options.saveDraft ?? ((input) => new NaverBlogPublisher().saveDraft(input));

  const job = await loadJob(jobId);
  if (!job) return { ok: false, reason: "job_not_found", detail: `job을 찾을 수 없습니다: ${jobId}` };

  if (job.status !== "approved") {
    return {
      ok: false,
      reason: "job_not_approved",
      detail: `job 상태가 approved가 아닙니다(현재: ${job.status}). Telegram에서 먼저 승인해주세요.`,
    };
  }

  const articles = await loadArticles(jobId);
  const article = articles[articles.length - 1];
  if (!article) {
    return { ok: false, reason: "article_not_found", detail: `job에 연결된 원고가 없습니다: ${jobId}` };
  }

  const existing = await loadExistingPublications(article.id);
  const already = existing.find((pub) => IN_PROGRESS_OR_DONE_STATUSES.includes(pub.status));
  if (already) {
    return {
      ok: true,
      publicationId: already.id,
      draftUrl: already.published_url ?? "",
      imageCount: 0,
      alreadyDone: true,
    };
  }

  const images = await loadImages(article.id);
  // image_url이 null인 row는 없어야 정상이지만(레코드 오류 방어), 타입상 가능하므로 걸러낸다.
  const naverImages: NaverPublishImageInput[] = images
    .filter((image): image is { image_url: string; alt_text: string | null } => Boolean(image.image_url))
    .map((image) => ({ url: image.image_url, alt: image.alt_text ?? undefined }));

  // 해시태그는 별도로 안 뽑는다 - runArticleJob.ts가 article.content 끝에 이미 "#태그1 #태그2 ..."
  // 텍스트 줄로 붙여뒀고, 그게 본문 paste에 그대로 포함된다(2026-08-28 §10 item 7 1차 실측 후
  // 사용자 결정 - NaverBlogPublisher.ts 상단 설명 참고: 발행 설정 패널을 열지 않는다).
  const bodyForPaste = stripImageMarkdownBlocks(article.content ?? "");
  const bodyHtml = convertArticleToNaverHtml(bodyForPaste);

  const draftResult = await saveDraft({
    title: article.title ?? job.keyword,
    bodyHtml,
    images: naverImages,
  });

  if (!draftResult.ok) {
    // 실패도 기록한다(SPRINT_4_DESIGN.md §8 - "조용히 죽는 job"을 만들지 않는다는 원칙).
    await savePublication({ articleId: article.id, status: "failed", publishedUrl: null }).catch(() => {
      // 기록 실패는 원래 실패 사유를 덮지 않는다 - 아래에서 draftResult의 실제 실패 사유를 반환한다.
    });
    return {
      ok: false,
      reason: "naver_save_failed",
      detail: `[${draftResult.stage}] ${draftResult.error}`,
      stage: draftResult.stage,
    };
  }

  const publication = await savePublication({
    articleId: article.id,
    status: "pending", // 임시저장 완료, 사람의 실제 발행 클릭을 기다리는 상태(§7 - 발행 버튼은 사람)
    publishedUrl: draftResult.draftUrl,
  });

  return {
    ok: true,
    publicationId: publication.id,
    draftUrl: draftResult.draftUrl,
    imageCount: naverImages.length,
    alreadyDone: false,
  };
}
