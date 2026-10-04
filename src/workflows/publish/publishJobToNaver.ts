// 승인된 원고 1건을 **네이버 블로그에 실제 발행**한다(2026-09-22 네이버 운영 재개).
//
// 2026-09-30: 배리에이션 단계가 폐지됐다. 발행하는 글은 작성 단계 원고(=최종 원고) 그대로다 -
// 채널은 텔레그램에서 사람이 고르므로 채널별로 다시 쓴 중복 원고가 없다.
//
// Blogspot 경로(publishArticleToBlogspot.ts)와 다른 점은 둘뿐이다:
//   1. HTML 변환기가 다르다 - convertArticleToNaverHtml(SmartEditor paste용)
//   2. 발행 수단이 다르다 - 공식 API가 없어 Playwright로 로그인된 브라우저를 조작한다
// 이미지는 **같은 것을 쓴다** - job.metadata.images를 그대로 읽는다. 네이버에는 참고 자료 링크아웃
// 섹션을 싣지 않는다(본문 끝 해시태그 줄은 그대로 둔다 - 네이버 태그로도 읽힌다).

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import {
  createPublication,
  listPublicationsByArticleIds,
} from "../../services/supabase/repositories/publicationRepository.js";
import { convertArticleToNaverPaste } from "../../services/publish/convertArticleToNaverHtml.js";
import { NaverBlogPublisher } from "../../services/publish/NaverBlogPublisher.js";
import type {
  NaverDraftSaveResult,
  NaverPublishImageInput,
  NaverVisibility,
} from "../../services/publish/NaverBlogPublisher.js";
import { naverCategoryNo } from "../../config/naverCategoryMapping.js";
import {
  manuscriptBodyWithoutImages,
  substituteConfirmedImages,
} from "../manuscripts/parseManuscriptBlocks.js";
import { readJobManuscriptImages } from "../manuscripts/manuscriptManifest.js";
import { pickFinalArticle } from "../manuscripts/pickFinalArticle.js";
import { removeReferencesBlock } from "../manuscripts/articleContentParts.js";
import { removeRelatedPosts } from "../manuscripts/appendRelatedPosts.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

export const NAVER_PLATFORM = "naver";

/** 이 상태의 publication이 있으면 이미 올라간 것으로 보고 다시 올리지 않는다. */
const IN_PROGRESS_OR_DONE: readonly PublicationRow["status"][] = ["pending", "publishing", "published"];

export type PublishJobToNaverResult =
  /** `warnings`: 올라갔지만 사람이 알아야 하는 차이(이미지 일부 누락 등). 폴러가 알림에 싣는다. */
  | { ok: true; publicationId: number; url: string; alreadyDone: boolean; warnings?: string[] }
  | { ok: false; reason: "job_not_found" | "job_not_approved" | "base_article_not_found" | "naver_failed"; detail: string };

export type PublishJobToNaverOptions = {
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  loadJobPublications?: (articleIds: number[]) => Promise<PublicationRow[]>;
  savePublication?: (input: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) => Promise<PublicationRow>;
  /** NaverBlogPublisher.publish와 같은 시그니처. 테스트에서 브라우저 대신 가짜 결과를 준다. */
  publish?: (
    input: { title: string; bodyHtml: string; images: ReadonlyArray<NaverPublishImageInput> },
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
  const savePublication =
    options.savePublication ??
    ((input) =>
      createPublication({
        article_id: input.articleId,
        platform: NAVER_PLATFORM,
        status: input.status,
        published_url: input.publishedUrl,
      }));
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
      alreadyDone: true,
    };
  }

  const picked = pickFinalArticle(articles);
  if (!picked) {
    return { ok: false, reason: "base_article_not_found", detail: `job에 연결된 원고가 없습니다: ${jobId}` };
  }
  const article = picked.final;

  // 이미지는 Blogspot과 **같은 것**을 쓴다(사용자 결정). 확정된 이미지만 마커 자리에 끼워 넣고,
  // 남은 마커는 지운다 - 공개 발행이라 `[IMAGE: ... — 웹 검색]` 글자가 독자에게 보이면 안 된다.
  // 2026-10-04: 이미지를 `<img src="외부URL">`로 붙여넣지 않는다. 네이버가 외부 이미지를 자기
  // 서버로 가져가지 않아 **대표이미지가 안 잡히고** 발행본이 Supabase를 핫링크하기 때문이다
  // (naverImageMarkers.ts 상단 설명). 본문에는 자리 표식만 넣고, 발행기가 그 자리에서 툴바로
  // 직접 업로드한다.
  const confirmedImages = readJobManuscriptImages(job);
  // 바깥 링크는 둘 다 뺀다: `참고 자료`(2026-09-22)와 Blogspot 내부 링크 "함께 보면 좋은 글"(2026-10-04 -
  // 준비 단계가 DB 원고에 저장하기 시작했다. 네이버에서는 바깥 링크라 같은 취지로 뺀다).
  const bodyWithImages = substituteConfirmedImages(
    removeRelatedPosts(removeReferencesBlock(article.content ?? "")),
    confirmedImages
  );
  const { html: bodyHtml, images } = convertArticleToNaverPaste(manuscriptBodyWithoutImages(bodyWithImages));

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

  const result = await publish({ title: article.title ?? job.keyword, bodyHtml, images }, visibility, categoryNo);

  if (!result.ok) {
    // 실패도 기록한다 - 조용히 죽는 job을 만들지 않는다.
    await savePublication({ articleId: article.id, status: "failed", publishedUrl: null }).catch(() => {});
    return { ok: false, reason: "naver_failed", detail: `[${result.stage}] ${result.error}` };
  }

  const publication = await savePublication({
    articleId: article.id,
    status: "published",
    publishedUrl: result.draftUrl,
  });

  return {
    ok: true,
    publicationId: publication.id,
    url: result.draftUrl,
    alreadyDone: false,
    warnings: result.warnings,
  };
}
