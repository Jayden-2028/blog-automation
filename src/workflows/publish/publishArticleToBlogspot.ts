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

import { KSCENE_DEFAULT_LABEL, KSCENE_LABEL_BY_SEED } from "../../config/ksceneSeeds.js";
import { loadKsceneImagesConfig } from "../../config/ksceneImages.js";
import { BLOGGER_CONFIG, BLOGSPOT_LABEL_BY_INTERNAL, KSCENE_BLOGGER_BLOG_ID } from "../../config/publishTargets.js";
import { trackOfJob } from "../../notifications/telegramTracks.js";
import { defaultRehostDeps, rehostImagesToPages } from "../../services/images/rehostImagesToPages.js";
import type { RehostResult } from "../../services/images/rehostImagesToPages.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import type { BloggerPublishResult } from "../../services/publish/blogger/BloggerClient.js";
import { convertArticleToHtml } from "../../services/publish/convertArticleToHtml.js";
import {
  listArticlesByJobId,
  updateArticleStatus,
} from "../../services/supabase/repositories/articleRepository.js";
import {
  countTodayPublicationsByPlatform,
  createPublication,
  listPublicationsByArticleIds,
  updatePublicationStatus,
} from "../../services/supabase/repositories/publicationRepository.js";
import { pickFinalArticle } from "../manuscripts/pickFinalArticle.js";
import { splitTrailingHashtags } from "../manuscripts/articleContentParts.js";
import { readJobManuscriptImages } from "../manuscripts/manuscriptManifest.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import { manuscriptBodyWithoutImages, substituteConfirmedImages } from "../manuscripts/parseManuscriptBlocks.js";
import type {
  BloggerInsertInput,
  BloggerInsertResult,
  BloggerUpdateInput,
  BloggerUpdateResult,
} from "../../services/publish/blogger/BloggerClient.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";
import { applyTkmStructure, pickTkmRelated } from "./tkmPostStructure.js";
import { BingWebmasterClient, resolveBingSiteUrl } from "../../services/bing/BingWebmasterClient.js";
import type { BingSubmitResult } from "../../services/bing/BingWebmasterClient.js";
import { TKM_ALL_GUIDES_PATH } from "./tkmPostStructure.js";
import { bloggerTkmSiteDeps, finalizeTkmPost, loadTkmSiteContext } from "./tkmSite.js";
import type { TkmSiteDeps } from "./tkmSite.js";

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
      alreadyDone: boolean;
      /** 새 글을 올린 게 아니라 **이미 있던 글의 본문을 지금 원고로 덮어썼다**(수정 반영). */
      updatedExisting?: boolean;
    }
  | { ok: false; reason: "disabled"; detail: string }
  | { ok: false; reason: "job_not_found" | "job_not_approved" | "base_article_not_found"; detail: string }
  | { ok: false; reason: "daily_limit"; detail: string }
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
  insertPost?: (input: BloggerInsertInput) => Promise<BloggerInsertResult>;
  /** enabled override (테스트). 생략하면 BLOGGER_CONFIG.enabled. */
  enabled?: boolean;
  /** 테스트 주입: 사용설명서 blogId override. 생략하면 KSCENE_BLOGGER_BLOG_ID. */
  ksceneBlogId?: string | undefined;
  /**
   * 테스트 주입: 사용설명서 발행 이미지를 Pages로 복사한다. 기본은 rehostImagesToPages(설정이 없으면 건너뛴다).
   * 반환의 images는 url이 치환된 목록이고, complete가 true여야 job에 `imagesRehostedAt`이 남는다.
   */
  rehostImages?: (input: { jobId: string; images: ManuscriptImage[] }) => Promise<RehostResult>;
  /** 테스트 주입: job.metadata 병합(복사 결과 기록). 기본은 ArticleJobRepository.mergeMetadata. */
  saveJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * 사용설명서 사이트 구조 보강(2026-10-27, tkmPostStructure.ts): Related 블록·All Guides 재생성·JSON-LD에 쓰는 Blogger 호출.
   * false면 건너뛴다(소제목 h2는 그대로 적용). 기본은 이 블로그의 BloggerClient.
   */
  tkmSite?: TkmSiteDeps | false;
  /**
   * 사용설명서 글이 공개 발행되면 그 글 URL과 All Guides URL을 Bing URL Submission API로 제출한다(2026-10-27).
   * 테스트 주입 지점. false면 건너뛴다. 기본은 BingWebmasterClient(키는 BING_WEBMASTER_API_KEY, 없으면 조용히 비활성).
   * 실패해도 발행 결과는 그대로 success다(결과는 job.metadata.bingSubmit에만 남는다).
   */
  bing?: { submitUrls: (siteUrl: string, urls: string[]) => Promise<BingSubmitResult> } | false;
};

export type BingSubmitRecord = {
  at: string;
  urls: string[];
  ok: boolean;
  error?: string;
  skipped?: string;
};

/** 어느 블로그·라벨로 올릴지. 사용설명서 트랙은 K-Scene blogId와 영문 라벨, 그 밖은 기존(BLOGGER_BLOG_ID·한글 라벨). */
export function resolveBloggerTarget(
  job: Pick<ArticleJobRow, "category" | "seed_query" | "metadata">,
  ksceneBlogId: string | undefined = KSCENE_BLOGGER_BLOG_ID
): { track: ReturnType<typeof trackOfJob>; blogId: string | undefined; label: string | undefined } {
  const track = trackOfJob(job);
  if (track === "kscene") {
    return {
      track,
      blogId: ksceneBlogId,
      // 라벨은 글을 낳은 시드가 정한다(ksceneSeeds.ts) - 시드가 바뀐 옛 job은 기본 라벨.
      label: KSCENE_LABEL_BY_SEED[job.seed_query ?? ""] ?? KSCENE_DEFAULT_LABEL,
    };
  }
  return { track, blogId: BLOGGER_CONFIG.blogId, label: job.category ? BLOGSPOT_LABEL_BY_INTERNAL[job.category] : undefined };
}

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
  const savePublication =
    options.savePublication ??
    (({ articleId, status, publishedUrl }) =>
      createPublication({ article_id: articleId, platform: BLOGSPOT_PLATFORM, status, published_url: publishedUrl }));
  const countToday = options.countToday ?? countTodayPublicationsByPlatform;
  // 어느 블로그로 올릴지는 job 트랙이 정한다. job을 읽은 뒤에 채운다(아래 target) - 기본 구현은 그때 만든 클라이언트를 쓴다.
  let bloggerClient: BloggerClient | null = null;
  const client = (): BloggerClient => (bloggerClient ??= new BloggerClient(target.blogId ? { blogId: target.blogId } : {}));
  let target: ReturnType<typeof resolveBloggerTarget>;
  const insertPost = options.insertPost ?? ((input) => client().insertPost(input));
  const publishPost = options.publishPost ?? ((postId: string) => client().publishPost(postId));
  const updatePost =
    options.updatePost ?? ((postId: string, input: BloggerUpdateInput) => client().updatePost(postId, input));
  const findPostIdByPath = options.findPostIdByPath ?? ((path: string) => client().getPostIdByPath(path));
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

  target = resolveBloggerTarget(job, "ksceneBlogId" in options ? options.ksceneBlogId : KSCENE_BLOGGER_BLOG_ID);
  if (target.track === "kscene" && !target.blogId) {
    // BLOGGER_BLOG_ID로 폴백하지 않는다 - 영어 글이 whynowissue(한국어 블로그)에 올라간다.
    return { ok: false, reason: "disabled", detail: "KSCENE_BLOGGER_BLOG_ID 미설정 - 사용설명서 글은 The Korea Manual 블로그 ID가 있어야 발행합니다" };
  }

  const articles = await loadArticles(jobId);
  const picked = pickFinalArticle(articles);
  if (!picked) {
    return { ok: false, reason: "base_article_not_found", detail: `job에 연결된 기준 원고가 없습니다: ${jobId}` };
  }

  const label = target.label;
  // JSON-LD description용 영어 검색 설명(번역 산출물, channelMeta.blogspot). draftMeta는 한글이라 쓰지 않는다.
  const englishSearchDescription =
    ((job.metadata?.channelMeta as ChannelMetaMap | undefined)?.[BLOGSPOT_PLATFORM]?.searchDescription as string | null | undefined) ?? null;

  // 사용설명서: 발행 이미지를 공개 Pages로 복사하고 본문 URL을 치환한다(개편3 §4.3-4). 실패·미설정이면 Supabase URL 그대로
  // 발행한다(발행을 막지 않는다). 원본 URL -> Pages URL 대응을 job.metadata.rehostedBySource에 남겨 재발행·이미지 수정 때
  // 이미 옮긴 것은 다시 옮기지 않는다. 전부 옮겨졌을 때만 `imagesRehostedAt`을 남긴다 - 그 표식이 있어야 storage-cleanup이
  // Supabase 원본을 지운다(없으면 핫링크 보호로 보존).
  let imagesForHtml: ManuscriptImage[] | null = null;
  const resolveImages = async (): Promise<ManuscriptImage[]> => {
    if (imagesForHtml) return imagesForHtml;
    const original = readJobManuscriptImages(job);
    if (target.track !== "kscene") return (imagesForHtml = original);

    const saved = (job.metadata?.rehostedBySource ?? {}) as Record<string, string>;
    const pending = original.filter((image) => image.url && !saved[image.url]);
    const rehost =
      options.rehostImages ??
      ((input) => rehostImagesToPages({ ...input, config: loadKsceneImagesConfig() }, defaultRehostDeps()));
    const saveJobMetadata = options.saveJobMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));

    let result: RehostResult | null = null;
    if (pending.length > 0) {
      try {
        result = await rehost({ jobId, images: pending });
      } catch (error) {
        console.warn(`⚠️ [publish] 이미지 복사 실패(Supabase URL로 발행): ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const failure of result?.failures ?? []) console.warn(`⚠️ [publish] 이미지 복사: ${failure}`);
    }

    const bySource: Record<string, string> = { ...saved };
    for (const image of result?.images ?? []) {
      const source = pending.find((candidate) => candidate.index === image.index)?.url;
      if (source && image.url && image.url !== source) bySource[source] = image.url;
    }
    imagesForHtml = original.map((image) => (image.url && bySource[image.url] ? { ...image, url: bySource[image.url] } : image));

    const hasImages = original.some((image) => image.url);
    const allMapped = hasImages && original.every((image) => !image.url || Boolean(bySource[image.url]));
    const grew = Object.keys(bySource).length > Object.keys(saved).length;
    const needsMark = allMapped && !job.metadata?.imagesRehostedAt;
    if (grew || needsMark) {
      await saveJobMetadata(jobId, {
        rehostedBySource: bySource,
        ...(allMapped ? { imagesRehostedAt: new Date().toISOString() } : {}),
      }).catch((error) => console.warn(`⚠️ [publish] 이미지 복사 기록 실패: ${error instanceof Error ? error.message : String(error)}`));
    }
    return imagesForHtml;
  };

  /**
   * 발행할 본문 HTML을 만든다. prepareManuscript.ts가 job.metadata.images에 저장해 둔 이미지를
   * 본문의 [IMAGE: 설명] 마커 자리에 확정된 것만(정확히 1장) 끼워 넣는다.
   *
   * 채워지지 않고 남은 마커(주로 `— 웹 검색` 자리)는 **초안이냐 공개냐**로 갈린다.
   *  - 초안: 그대로 둔다. 편집 화면에서 "여기에 자료를 넣어라"는 TODO 표시로 쓰인다.
   *  - 공개: **반드시 지운다.** 안 지우면 `[IMAGE: ... — 웹 검색]`이라는 글자가 독자에게 그대로
   *    보인다(convertArticleToHtml의 placeholder 경로가 <p>로 렌더한다).
   */
  const buildContentHtml = async (article: ArticleRow, draft: boolean): Promise<string> => {
    const confirmedImages = await resolveImages();
    const bodyWithImages = substituteConfirmedImages(splitTrailingHashtags(article.content ?? "").body, confirmedImages);
    return convertArticleToHtml(draft ? bodyWithImages : manuscriptBodyWithoutImages(bodyWithImages), {
      semanticHeadings: target.track === "kscene",
    });
  };

  // 사용설명서: 본문에 Related 블록을 넣고(발행 전), 공개 뒤에는 All Guides 재생성 + 본문 마무리(finalizeTkmPost)를 한다.
  // 초안에는 넣지 않는다 - 초안은 공개 주소가 없고 버튼 경로는 공개 발행이다.
  const tkmSite: TkmSiteDeps | null =
    target.track !== "kscene" || options.tkmSite === false ? null : options.tkmSite ?? bloggerTkmSiteDeps(client());
  const withTkmRelated = async (html: string, self: { url: string | null; title: string; published: string | null }): Promise<string> => {
    if (!tkmSite) return html;
    const site = await loadTkmSiteContext(tkmSite);
    if (!site) return html;
    const related = pickTkmRelated({ ...self, labels: label ? [label] : [] }, site.posts, site.allGuidesUrl);
    return applyTkmStructure(html, { related, jsonLd: null }).html;
  };
  const finalizeTkm = async (input: { postId: string; url: string; title: string; published: string; html: string }): Promise<string | null> => {
    if (!tkmSite || !input.postId || !input.url) return null;
    const result = await finalizeTkmPost(
      tkmSite,
      { ...input, labels: label ? [label] : [], searchDescription: englishSearchDescription },
      input.html
    );
    for (const warning of result.warnings) console.warn(`⚠️ [tkm] ${warning}`);
    return result.allGuidesUrl;
  };

  // 사용설명서 글이 새로 공개되면 [글 URL, All Guides URL]을 한 번에 Bing에 제출하고 결과를 job.metadata.bingSubmit에 남긴다.
  // 어떤 실패도 던지지 않는다 - 글은 이미 공개됐다.
  const submitToBing = async (postUrl: string, allGuidesUrl: string | null): Promise<void> => {
    if (target.track !== "kscene" || options.bing === false || !postUrl) return;
    try {
      const siteUrl = resolveBingSiteUrl(postUrl);
      if (!siteUrl) return;
      const hubUrl = allGuidesUrl ?? `${siteUrl.replace(/\/$/, "")}${TKM_ALL_GUIDES_PATH}`;
      const urls = [postUrl, hubUrl];
      const result = await (options.bing ?? new BingWebmasterClient()).submitUrls(siteUrl, urls);
      const record: BingSubmitRecord = { at: new Date().toISOString(), urls, ok: "ok" in result && result.ok };
      if ("error" in result) record.error = result.error;
      if ("skipped" in result) record.skipped = result.skipped;
      if (record.error) console.warn(`⚠️ [bing] URL 제출 실패(발행은 성공): ${record.error}`);
      else if (!record.skipped) console.log(`🔎 [bing] URL ${urls.length}개 제출`);
      const saveJobMetadata = options.saveJobMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
      await saveJobMetadata(jobId, { bingSubmit: record }).catch((error) =>
        console.warn(`⚠️ [bing] 제출 기록 실패: ${error instanceof Error ? error.message : String(error)}`)
      );
    } catch (error) {
      console.warn(`⚠️ [bing] 제출 처리 오류(발행은 성공): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 최종 원고 = 작성 단계 원고(2026-09-30 배리에이션 폐지). 과거 배리에이션이 더 새것이면 그것.
  const finalArticle: ArticleRow = picked.final;

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
    const shouldRefresh = Boolean(postId) && (done.status === "published" || (wantsPublic && done.status === "pending"));

    if (postId && shouldRefresh) {
      const refreshTitle = finalArticle.title ?? job.keyword;
      const knownUrl = done.status === "published" ? done.published_url : null;
      const refreshHtml = await withTkmRelated(await buildContentHtml(finalArticle, false), {
        url: knownUrl,
        title: refreshTitle,
        published: knownUrl ? done.created_at : null,
      });
      const refreshed = await updatePost(postId, {
        title: refreshTitle,
        contentHtml: refreshHtml,
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
        await markPublished({ publicationId: done.id, url: promoted.url, articleId: finalArticle.id });
        const promotedHub = await finalizeTkm({ postId, url: promoted.url, title: refreshTitle, published: promoted.publishedAt || new Date().toISOString(), html: refreshHtml });
        await submitToBing(promoted.url, promotedHub);
        return { ok: true, publicationId: done.id, url: promoted.url, isDraft: false, alreadyDone: false };
      }

      // 이미 공개돼 있던 글이다 - 주소는 그대로고 본문만 바뀐다.
      await markPublished({ publicationId: done.id, url: done.published_url ?? "", articleId: finalArticle.id });
      await finalizeTkm({ postId, url: done.published_url ?? "", title: refreshTitle, published: done.created_at, html: refreshHtml });
      return {
        ok: true,
        publicationId: done.id,
        url: done.published_url ?? "",
        isDraft: false,
        alreadyDone: false,
        updatedExisting: true,
      };
    }

    return {
      ok: true,
      publicationId: done.id,
      url: done.published_url ?? "",
      isDraft: done.status === "pending",
      alreadyDone: true,
    };
  }

  // 일일 상한(하드 가드). 배리에이션 생성 전에 확인해 LLM 비용도 아낀다.
  const todayCount = await countToday(BLOGSPOT_PLATFORM);
  if (todayCount >= BLOGGER_CONFIG.dailyLimit) {
    return {
      ok: false,
      reason: "daily_limit",
      // "다음 폴링에서 재시도한다"고 쓰면 안 된다 - 폴링은 2026-09-14에 폐지됐고 발행을
      // 재시도하는 스케줄은 하나도 없다. 사람이 버튼을 다시 누르지 않으면 그대로 묻힌다.
      detail: `오늘 Blogspot 발행이 상한(${BLOGGER_CONFIG.dailyLimit})에 도달했습니다. 자동 재시도는 없습니다 - 자정(한국시간)이 지난 뒤 발행 버튼을 다시 눌러주세요.`,
    };
  }

  // articles 테이블엔 searchDescription 컬럼이 없다 - prepareManuscript.ts와 같은 자리
  // (job.metadata.channelMeta.blogspot)에서 복구한다. 재사용 경로(이미 배리에이션이 있음)는 여기서
  // 채워지고, 신규 생성 경로는 아래에서 방금 만든 값으로 덮어쓴다.
  const channelMeta = (job.metadata?.channelMeta as ChannelMetaMap | undefined) ?? {};
  const draftSearchDescription = (job.metadata?.draftMeta as { searchDescription?: unknown } | undefined)?.searchDescription;
  const searchDescription: string | null =
    (typeof draftSearchDescription === "string" ? draftSearchDescription : null) ??
    channelMeta[BLOGSPOT_PLATFORM]?.searchDescription ??
    null;

  const isDraft = options.asDraft ?? BLOGGER_CONFIG.publishAsDraft;
  const postTitle = finalArticle.title ?? job.keyword;
  const baseHtml = await buildContentHtml(finalArticle, isDraft);
  const contentHtml = isDraft ? baseHtml : await withTkmRelated(baseHtml, { url: null, title: postTitle, published: null });

  const inserted = await insertPost({
    title: postTitle,
    contentHtml,
    labels: label ? [label] : undefined,
    searchDescription,
    isDraft,
  });

  if (!inserted.ok) {
    await savePublication({ articleId: finalArticle.id, status: "failed", publishedUrl: null }).catch(() => {});
    return { ok: false, reason: "blogger_failed", detail: `[${inserted.stage}] ${inserted.error}`, stage: inserted.stage };
  }

  const publication = await savePublication({
    articleId: finalArticle.id,
    status: inserted.isDraft ? "pending" : "published",
    publishedUrl: inserted.url,
  });
  // 공개 발행이면 배리에이션 원고 상태도 published로 올린다(기준 원고와 별개). draft면 pending 유지.
  if (!inserted.isDraft) {
    await updateArticleStatus(finalArticle.id, "published").catch(() => {});
    const insertedHub = await finalizeTkm({ postId: inserted.postId, url: inserted.url, title: postTitle, published: new Date().toISOString(), html: contentHtml });
    await submitToBing(inserted.url, insertedHub);
  }

  return {
    ok: true,
    publicationId: publication.id,
    url: inserted.url,
    isDraft: inserted.isDraft,
    alreadyDone: false,
  };
}
