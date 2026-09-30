// 승인된 job 1건 -> Blogspot 원고 1건 준비 (반자동 업로드 대체, 2026-09-05).
//
// 2026-09-15 Blogspot 단독 운영 결정(BLOGSPOT_ONLY_DESIGN.md)으로 채널 배정이 사라졌다.
// 예전에는 config/channelRouting.ts가 job.category로 티스토리/블로그스팟을 갈랐고, 배정표에
// 없는 카테고리는 실패였다. 이제 모든 원고가 Blogspot으로 간다 - 실패 경로가 하나 줄었다.
//
// 작성 단계 산출물(platform=null article)이 곧 최종 원고다(2026-09-30 사용자 결정 - 배리에이션 단계
// 폐지. 채널은 텔레그램에서 사람이 고르므로 채널별 중복 원고가 없다). 여기서는 재작성하지 않고
// 그 원고에 내부 링크를 붙이고 이미지를 채운다. 발행 메타(searchDescription/slug/shortName/태그)는
// writer가 frontmatter로 남긴 것을 job.metadata.draftMeta에서 읽는다. Playwright/API 업로드는 여기서
// 하지 않는다 - 결과를 로컬 .md 파일로 저장해 사람이 뷰어에서 복사해 붙여넣는다.
//
// 과거(배리에이션 시절) 만든 platform="blogspot" article이 기준 원고보다 새것이면 그대로 재사용한다 -
// 이미 그 원고 기준으로 이미지가 채워져 있기 때문이다. 키 이름 `channelMeta.blogspot`은 그 과거
// job의 값을 읽기 위해 유지한다.
//
// 이미지 자동 생성은 여기서 원고가 확정된 직후에 한 번 돈다(BLOGSPOT_ONLY_DESIGN.md §3-2) -
// 승인된 원고에만 비용을 쓰기 위해서다. best-effort라 실패해도 원고 준비는 success로 끝낸다.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { manuscriptFilePath, PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { describeImagePolicy, instagramImageConfig } from "../instagram-capture/instagramImagePolicy.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { generateManuscriptImages } from "../images/generateManuscriptImages.js";
import { collectWebImagesForJob } from "../images/collectWebImagesForJob.js";
import { readJobBrief } from "../brief/buildKeywordBrief.js";
import { removeTableMarkers, shiftImageIndexes, shiftIndexedRecord } from "./removeTableMarkers.js";
import { updateArticle } from "../../services/supabase/repositories/articleRepository.js";
import { readImageDirectUrls, readImageRequirements } from "../images/applyImageEditRequest.js";
import { buildFallbackImagePrompts } from "../images/buildFallbackImagePrompts.js";
import type { FallbackImagePrompt } from "../images/buildFallbackImagePrompts.js";
import type { UnfilledSlot } from "../images/collectWebImages.js";
import { renderTableImagesForJob } from "../images/renderTableImagesForJob.js";
import { capturePagesForJob } from "../images/capturePagesForJob.js";
import { alignImagePrompts } from "./alignImagePrompts.js";
import { pickFinalArticle } from "./pickFinalArticle.js";
import { splitTrailingHashtags } from "./articleContentParts.js";
import { appendRelatedPosts, pickRelatedPosts } from "./appendRelatedPosts.js";
import { listPublishedPosts } from "../../services/supabase/repositories/publicationRepository.js";
import type { PublishedPost } from "../../services/supabase/repositories/publicationRepository.js";
import { readJobManuscriptImages } from "./manuscriptManifest.js";
import type { ManuscriptEntry, ManuscriptImage, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

/** platform 컬럼 값이자 metadata.channelMeta의 키. 채널 개념은 없지만 과거 행 호환으로 유지한다. */
export const BLOGSPOT_PLATFORM = "blogspot";

/** job.metadata.channelMeta.blogspot에 저장하는 형태 - articles 테이블에 없는 필드를 보존한다. */
type ChannelMetaEntry = {
  searchDescription: string | null;
  slug: string | null;
  tags: string[];
  /** 로컬 보관함 폴더로 쓸 짧은 한글 키워드(2026-09-18). 옛 job엔 없다 - 그때는 키워드로 폴백. */
  shortName?: string | null;
};
type ChannelMetaMap = Record<string, ChannelMetaEntry>;

export type PrepareManuscriptResult =
  | { status: "success"; topic: ManuscriptTopicEntry; imageFailures: string[] }
  | { status: "failed"; reason: string };

export type PrepareManuscriptOptions = {
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  /** 내부 링크 후보(이미 발행된 글). 기본은 publications에서 읽는다. false면 링크를 붙이지 않는다. */
  loadPublishedPosts?: (() => Promise<PublishedPost[]>) | false;
  writeManuscriptFile?: (path: string, content: string) => Promise<void>;
  /** job.metadata 병합(이미지 진행 표시 등). 기본은 ArticleJobRepository.mergeMetadata. */
  mergeJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** 이미지 자동 생성. 기본은 generateManuscriptImages. false를 주면 건너뛴다(테스트/재실행). */
  generateImages?:
    | false
    | ((input: {
        jobId: string;
        keyword: string;
        date: string;
        body: string;
        imagePrompts: string[];
      },
      options?: { onlyIndexes?: number[]; fallbackSlots?: FallbackImagePrompt[] }) => Promise<{
        images: ManuscriptImage[];
        failures: string[];
      }>);
  /**
   * `웹 검색` 자리 수집. 기본은 collectWebImagesForJob(Claude WebSearch → Storage 업로드).
   * false를 주면 건너뛴다(테스트/재실행). 외부 검색을 타므로 테스트에서는 반드시 꺼야 한다.
   */
  collectWebImages?:
    | false
    | ((input: {
        jobId: string;
        keyword: string;
        /** 서치풀·화질 하한을 정한다(2026-09-24). */
        category?: string | null;
        briefType?: string | null;
        body: string;
        imagePrompts: string[];
        filledIndexes: number[];
      }) => Promise<{ images: ManuscriptImage[]; failures: string[]; unfilled: UnfilledSlot[] }>);
  /**
   * 웹에서 못 찾은 자리를 AI 생성 프롬프트로 바꾼다. 기본은 buildFallbackImagePrompts.
   * false를 주면 빈 자리를 그대로 둔다(테스트 - 헤드리스 Claude를 띄우면 안 된다).
   */
  buildFallbackPrompts?:
    | false
    | ((input: { keyword: string; unfilled: UnfilledSlot[] }) => Promise<{
        slots: FallbackImagePrompt[];
        failures: string[];
      }>);
  /**
   * `표 생성` 자리 렌더. 기본은 renderTableImagesForJob(본문 표·목록 → Chromium → Storage).
   * false를 주면 건너뛴다(테스트 - 브라우저를 띄우면 안 된다).
   */
  renderTableImages?:
    | false
    | ((input: {
        jobId: string;
        body: string;
        imagePrompts: string[];
        filledIndexes: number[];
      }) => Promise<{ images: ManuscriptImage[]; failures: string[] }>);
  /**
   * `페이지 캡처` 자리. 기본은 capturePagesForJob(리서처가 정한 URL을 Chromium으로 연다).
   * false를 주면 건너뛴다(테스트 - 브라우저를 띄우면 안 된다).
   */
  capturePages?:
    | false
    | ((input: {
        jobId: string;
        body: string;
        imagePrompts: string[];
        filledIndexes: number[];
      }) => Promise<{ images: ManuscriptImage[]; failures: string[] }>);
  /** 테스트 주입용. 기본은 현재 시각(Asia/Seoul). */
  now?: () => Date;
};

function kstDateString(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

const IMAGE_LINE_RE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;

/**
 * `.md` 파일에 쓰기 직전에만 [IMAGE: 설명] 바로 다음 줄에 [IMAGE PROMPT: ...]를 등장 순서로
 * 재삽입한다(writer.md §8 원래 형식 복원 - parseDraftFile.ts가 DB 저장 전에 빼낸 것을 되살림).
 * manifest/화면용 entry.body는 건드리지 않는다(parseManuscriptBlocks가 렌더 시점에 다시 짝짓는다) -
 * 재삽입한 결과를 다시 파싱하면 프롬프트 줄이 텍스트로 섞이므로 라운드트립하지 않는다.
 * 마커 개수와 imagePrompts 길이가 다르면 잘못 짝지어질 위험이 있어 그대로 둔다(안전).
 */
function reinsertImagePrompts(body: string, imagePrompts: string[]): string {
  const lines = body.split("\n");
  const markerCount = lines.filter((line) => IMAGE_LINE_RE.test(line.trim())).length;
  if (markerCount === 0 || markerCount !== imagePrompts.length) return body;

  const result: string[] = [];
  let index = 0;
  for (const line of lines) {
    result.push(line);
    if (IMAGE_LINE_RE.test(line.trim())) {
      result.push(`[IMAGE PROMPT: ${imagePrompts[index]}]`);
      index += 1;
    }
  }
  return result.join("\n");
}

/**
 * job.metadata.imagePrompts는 parseDraftFile.ts가 본문에서 빼낸 "[IMAGE PROMPT: ...]" 지시를
 * 등장 순서대로 담은 배열이다(runArticleJob.ts). 기준 원고와 배리에이션 모두 같은 순서로
 * "[IMAGE: 설명]" 마커를 남기므로(generateArticleVariant.ts 프롬프트 지시) 배리에이션도 같은
 * imagePrompts를 그대로 쓴다 - 실제 대응은 parseManuscriptBlocks가 마커 개수와 대조해 검증한다.
 */
function readImagePrompts(job: ArticleJobRow): string[] {
  const raw = job.metadata?.imagePrompts;
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
}

function frontMatterFile(entry: Omit<ManuscriptEntry, "filePath">): string {
  const tagsLine = entry.tags.length > 0 ? entry.tags.join(", ") : "";
  return [
    "---",
    `title: ${entry.title}`,
    `searchDescription: ${entry.searchDescription ?? ""}`,
    `slug: ${entry.slug ?? ""}`,
    `tags: ${tagsLine}`,
    "---",
    "",
    entry.body,
    "",
  ].join("\n");
}

async function defaultWriteManuscriptFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * 이미 발행된 글 중 관련 있는 것을 본문 끝에 내부 링크로 붙인다(2026-09-22).
 *
 * 실패해도 원고를 막지 않는다 - 링크는 부가 기능이고, 여기서 예외를 던지면 원고 준비 전체가
 * 실패한다. 발행 기록을 못 읽으면 링크 없이 그대로 간다.
 *
 * **새로 만드는 배리에이션에만** 붙인다. 이미 만들어진 원고를 재사용하는 경로에서 본문만 바꾸면
 * DB의 article 행과 원고 파일이 어긋난다.
 */
async function withRelatedPosts(
  content: string,
  job: ArticleJobRow,
  options: PrepareManuscriptOptions
): Promise<string> {
  const loadPublished = options.loadPublishedPosts;
  if (loadPublished === false) return content;

  try {
    const candidates = await (loadPublished ?? listPublishedPosts)();
    const related = pickRelatedPosts(
      { jobId: job.id, keyword: job.keyword, category: job.category ?? null },
      candidates
    );
    if (related.length === 0) return content;
    console.log(`· [manuscripts] ${job.keyword}: 내부 링크 ${related.length}개를 붙였습니다.`);
    return appendRelatedPosts(content, related);
  } catch (error) {
    console.warn(
      `⚠️ [manuscripts] ${job.keyword}: 내부 링크를 붙이지 못했습니다(무시하고 계속): ${error instanceof Error ? error.message : error}`
    );
    return content;
  }
}

type DraftMeta = { searchDescription: string | null; slug: string | null; shortName: string | null; tags: string[] };

function readDraftMeta(job: ArticleJobRow): DraftMeta {
  const raw = job.metadata?.draftMeta as Partial<DraftMeta> | undefined;
  return {
    searchDescription: typeof raw?.searchDescription === "string" ? raw.searchDescription : null,
    slug: typeof raw?.slug === "string" ? raw.slug : null,
    shortName: typeof raw?.shortName === "string" ? raw.shortName : null,
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

export async function prepareManuscript(
  job: ArticleJobRow,
  options: PrepareManuscriptOptions = {}
): Promise<PrepareManuscriptResult> {
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const writeManuscriptFile = options.writeManuscriptFile ?? defaultWriteManuscriptFile;
  const mergeJobMetadata =
    options.mergeJobMetadata ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));
  // 인스타 job은 카테고리에 따라 AI 생성을 켠다(2026-09-23). 전역 스위치를 켜면 같은 저장소를
  // 쓰는 일반 키워드 job까지 유료 생성이 돌기 때문에, 이 job에만 config를 덮어씌운다.
  // 인스타 job이 아니면 null이 나오고 아무것도 바뀌지 않는다.
  const imagePolicy = instagramImageConfig({
    source: (job.metadata as Record<string, unknown> | null)?.source,
    category: job.category ?? null,
  });
  const baseGenerateImages =
    options.generateImages === undefined ? generateManuscriptImages : options.generateImages;
  const generateImages =
    imagePolicy && options.generateImages === undefined
      ? (input: Parameters<typeof generateManuscriptImages>[0], extra?: Parameters<typeof generateManuscriptImages>[1]) =>
          generateManuscriptImages(input, { ...extra, config: imagePolicy })
      : baseGenerateImages;
  const policyNote = describeImagePolicy({
    source: (job.metadata as Record<string, unknown> | null)?.source,
    category: job.category ?? null,
  });
  if (policyNote) console.log(`· [manuscripts] ${job.keyword}: ${policyNote}`);
  const collectWebImages =
    options.collectWebImages === undefined ? collectWebImagesForJob : options.collectWebImages;
  const renderTableImages =
    options.renderTableImages === undefined ? renderTableImagesForJob : options.renderTableImages;
  const capturePages = options.capturePages === undefined ? capturePagesForJob : options.capturePages;
  const buildFallbacks =
    options.buildFallbackPrompts === undefined ? buildFallbackImagePrompts : options.buildFallbackPrompts;
  const now = options.now ?? (() => new Date());

  const articles = await loadArticles(job.id);
  const picked = pickFinalArticle(articles);
  if (!picked) return { status: "failed", reason: "기준 원고 없음" };
  const { base: baseArticle, legacyVariant: existing } = picked;

  const date = kstDateString(now());
  const imagePrompts = readImagePrompts(job);

  const channelMeta = (job.metadata?.channelMeta as ChannelMetaMap | undefined) ?? {};

  let title: string;
  let content: string;
  let searchDescription: string | null = null;
  let slug: string | null = null;
  let tags: string[] = [];
  let shortName: string | null = null;

  if (existing) {
    title = existing.title ?? job.keyword;
    content = existing.content ?? "";
    // articles 테이블엔 searchDescription/slug/tags 컬럼이 없다 - 최초 생성 시 job.metadata에
    // 함께 저장해 둔 값이 있으면 여기서 복구한다(2026-09-15 이전에 만들어진 job은 이 값이 없어
    // 계속 비어 있다 - 그 경우 원고를 새로 만들어야 채워진다).
    const saved = channelMeta[BLOGSPOT_PLATFORM];
    if (saved) {
      searchDescription = saved.searchDescription;
      slug = saved.slug;
      tags = saved.tags;
      shortName = saved.shortName ?? null;
    }
  } else {
    // 기준 원고가 곧 최종본이다. 발행 메타는 writer가 남긴 draftMeta에서, 태그는 본문 끝 해시태그 줄에서 읽는다.
    const meta = readDraftMeta(job);
    const split = splitTrailingHashtags(baseArticle.content ?? "");
    title = baseArticle.title ?? job.keyword;
    content = split.body;
    searchDescription = meta.searchDescription;
    slug = meta.slug;
    shortName = meta.shortName;
    tags = meta.tags.length > 0 ? meta.tags : split.tags;
    content = await withRelatedPosts(content, job, options);
    // `표 생성` 자리는 만들지 않는다(2026-09-24 사용자 결정 - 메인 규칙 5번). 저장 파일에 빈 칸이 남지 않게 뺀다.
    const cleaned = removeTableMarkers(content);
    if (cleaned.removed > 0) {
      content = cleaned.body;
      console.log(`ℹ️ [manuscripts] ${job.keyword}: 표 생성 자리 ${cleaned.removed}개를 뺐습니다.`);
    }
  }

  const imageFailures: string[] = [];

  // 배리에이션이 문단을 재배열하면 마커 순서도 바뀌는데, imagePrompts는 **기준 원고 순서**로
  // 저장돼 있다. 번호로만 짝지으면 통째로 밀려 "검색은 A, 판정은 B"가 된다 - 2026-09-21 지창욱
  // 원고에서 6자리 중 5자리가 이렇게 어긋나 웹 검색이 전부 실패했다. 재배열을 막는 대신(그건
  // 배리에이션의 일이다) 설명을 보고 검색어가 제 마커를 따라가게 맞춘다.
  const aligned = alignImagePrompts(baseArticle.content ?? "", content, imagePrompts);
  const slotPrompts = aligned ? aligned.prompts : imagePrompts;
  if (aligned?.reordered) {
    console.log(`· [manuscripts] ${job.keyword}: 마커 순서가 기준 원고와 달라 검색어를 다시 맞췄습니다.`);
  }
  if (aligned && aligned.unmatched.length > 0) {
    imageFailures.push(
      `기준 원고에 대응이 없는 마커 ${aligned.unmatched.join(", ")}번 - 검색어를 비웠습니다(엉뚱한 검색어를 붙이지 않기 위해).`
    );
  }

  // 이미지 생성은 원고가 확정된 뒤에만. job당 1회 - metadata.imagesReadyAt으로 멱등 처리한다.
  // 실패는 원고를 막지 않는다(images가 빈 채로 넘어가고 뷰어는 프롬프트만 보여준다).
  let images: ManuscriptImage[] = readJobManuscriptImages(job);
  // 이미 저장돼 있던 원고에도 `표 생성` 금지를 적용한다(재실행 경로, 2026-09-24).
  // 순위 `페이지 캡처`는 본문을 옮긴 표가 아니므로 대상이 아니다.
  if (existing) {
    const cleaned = removeTableMarkers(content);
    if (cleaned.removed > 0) {
      content = cleaned.body;
      await updateArticle(existing.id, { content });

      // **번호로 붙어 있는 것들을 같이 당긴다**(실측 사고). 마커를 지우면 그 뒤 자리 번호가
      // 하나씩 내려가는데 metadata는 옛 번호 그대로라, 사용자가 6번에 준 이미지 주소가
      // 존재하지 않는 자리를 가리키게 됐다.
      images = shiftImageIndexes(images, cleaned.removedIndexes);
      await mergeJobMetadata(job.id, {
        images,
        imageRequirements: shiftIndexedRecord(
          readImageRequirements(job.metadata as Record<string, unknown> | null),
          cleaned.removedIndexes
        ),
        imageDirectUrls: shiftIndexedRecord(
          readImageDirectUrls(job.metadata as Record<string, unknown> | null),
          cleaned.removedIndexes
        ),
      });
      console.log(
        `ℹ️ [manuscripts] ${job.keyword}: 표 생성 자리 ${cleaned.removed}개를 빼고 자리 번호를 당겼습니다(${cleaned.removedIndexes.join(", ")}번).`
      );
    }
  }


  if (generateImages && images.length === 0 && !job.metadata?.imagesReadyAt) {
    const outcome = await generateImages({
      jobId: job.id,
      keyword: job.keyword,
      date,
      body: content,
      imagePrompts: slotPrompts,
    });
    images = outcome.images;
    imageFailures.push(...outcome.failures);
    if (images.length > 0) {
      await mergeJobMetadata(job.id, { imagesReadyAt: now().toISOString(), images });
    }
  }

  // `표 생성` 자리를 본문 데이터로 그린다(2026-09-18). 웹 검색보다 **먼저** 해야 한다 - 일정·순위표는
  // 검색으로 못 찾는 게 실측으로 드러났고, 우리 데이터로 그리는 편이 정확하다.
  if (renderTableImages && !job.metadata?.tableImagesReadyAt) {
    const outcome = await renderTableImages({
      jobId: job.id,
      body: content,
      imagePrompts: slotPrompts,
      filledIndexes: images.filter((i) => i.url).map((i) => i.index),
    });
    imageFailures.push(...outcome.failures);
    if (outcome.images.length > 0) {
      images = [...images.filter((e) => !outcome.images.some((n) => n.index === e.index)), ...outcome.images].sort(
        (a, b) => a.index - b.index
      );
      await mergeJobMetadata(job.id, { tableImagesReadyAt: now().toISOString(), images });
    }
  }

  // `페이지 캡처` 자리(2026-09-18). 리서처가 열어본 URL을 그대로 연다 - 웹 검색으로는 못 찾고
  // AI로도 못 만드는데 주소만 알면 되는 자리다(스타벅스 프로모션 페이지, OTT 시청 화면 등).
  // 표 렌더와 웹 수집 **사이**에 둔다: 표보다 구체적이고, 웹 검색보다 확실하다.
  if (capturePages && !job.metadata?.pageCapturesReadyAt) {
    const outcome = await capturePages({
      jobId: job.id,
      body: content,
      imagePrompts: slotPrompts,
      filledIndexes: images.filter((i) => i.url).map((i) => i.index),
    });
    imageFailures.push(...outcome.failures);
    if (outcome.images.length > 0) {
      images = [...images.filter((e) => !outcome.images.some((n) => n.index === e.index)), ...outcome.images].sort(
        (a, b) => a.index - b.index
      );
      await mergeJobMetadata(job.id, { pageCapturesReadyAt: now().toISOString(), images });
    }
  }

  // `웹 검색` 자리를 Claude(WebSearch)로 채운다(2026-09-18). 생성과 별개 게이트를 쓰는 이유: 생성은
  // 이미 끝났는데 수집만 새로 붙은 원고가 있고, 둘의 실패 조건도 다르다(생성=유료 API, 수집=검색 결과).
  // 여기서 실패해도 원고는 그대로 간다 - 빈 자리는 뷰어가 검색어와 함께 "채울 것"으로 띄운다.
  if (collectWebImages && !job.metadata?.webImagesReadyAt) {
    // 웹 검색 자리는 **웹에서 온 이미지(sourcePage)** 가 있을 때만 채워진 것으로 본다(2026-09-17 저녁).
    // AI 폴백으로 메운 자리는 다시 웹을 찾는다 - 사용자가 원하는 건 실제 사진이고, 정책이 바뀌면
    // (C안) 전에 못 찾던 것을 이제 찾을 수 있다. 웹 이미지가 오면 index 기준 병합에서 폴백을 덮는다.
    const outcome = await collectWebImages({
      jobId: job.id,
      keyword: job.keyword,
      category: job.category ?? null,
      briefType: readJobBrief(job.metadata as Record<string, unknown> | null)?.type ?? null,
      // 이미 쓰고 있는 컷을 중복 검사기에 등록시킨다(2026-09-24) - 일부 자리만 재수집할 때
      // 같은 사진이 다시 들어오는 것을 막는다.
      existingImageUrls: Object.fromEntries(
        images.filter((i) => i.url).map((i) => [i.index, i.url as string])
      ),
      body: content,
      imagePrompts: slotPrompts,
      filledIndexes: images.filter((i) => i.url && i.sourcePage).map((i) => i.index),
      // "🖼 이미지 수정"에서 사람이 적어 보낸 자리별 요구(2026-09-22). 없으면 빈 객체다.
      requirements: readImageRequirements(job.metadata as Record<string, unknown> | null),
      // 사용자가 주소를 찍어준 자리는 검색하지 않고 그대로 쓴다(2026-09-22).
      directUrls: readImageDirectUrls(job.metadata as Record<string, unknown> | null),
    });
    imageFailures.push(...outcome.failures);
    if (outcome.images.length > 0) {
      images = [...images.filter((e) => !outcome.images.some((n) => n.index === e.index)), ...outcome.images].sort(
        (a, b) => a.index - b.index
      );
      await mergeJobMetadata(job.id, { webImagesReadyAt: now().toISOString(), images });
    }

    // 웹에서 못 찾은 자리를 AI 생성으로 메운다(2026-09-17 사용자 보고 대응). 지금까지는 여기서
    // 끝나 자리가 그대로 비었다 - 09-17 원고 20자리 중 18자리가 그렇게 비었다. "빈 자리보다 AI
    // 이미지가 낫다"는 방침(rules/output-format.md §8-4)을 실행에도 반영한다.
    //
    // 본문 마커는 `웹 검색` 그대로 둔다: 그 자리가 원래 실제 사진을 원한다는 사실은 남아 있어야
    // 나중에 사람이 더 나은 사진으로 갈아끼울 수 있다.
    // 폴백은 **아무 이미지도 없는 자리**에만 - 지난 실행의 폴백 이미지가 있으면 유료 생성을 반복하지 않는다.
    const stillEmpty = outcome.unfilled.filter((u) => !images.some((i) => i.index === u.index && i.url));
    if (generateImages && buildFallbacks && stillEmpty.length > 0) {
      const fallback = await buildFallbacks({ keyword: job.keyword, unfilled: stillEmpty });
      imageFailures.push(...fallback.failures);

      if (fallback.slots.length > 0) {
        const filled = await generateImages(
          { jobId: job.id, keyword: job.keyword, date, body: content, imagePrompts: slotPrompts },
          { onlyIndexes: [], fallbackSlots: fallback.slots }
        );
        imageFailures.push(...filled.failures);
        const usable = filled.images.filter((i) => i.url);
        if (usable.length > 0) {
          images = [...images.filter((e) => !usable.some((n) => n.index === e.index)), ...usable].sort(
            (a, b) => a.index - b.index
          );
          await mergeJobMetadata(job.id, { webImagesReadyAt: now().toISOString(), images });
        }
      }
    }
  }

  // 과거에 만들어 둔 네이버 배리에이션은 뷰어가 그대로 보여준다(새로 만들지는 않는다 - 2026-09-30 폐지).
  const naver: { title: string; body: string; tags: string[] } | null =
    (job.metadata?.naverVariant as { title: string; body: string; tags: string[] } | undefined) ?? null;

  // 인스타그램 수동 큐레이션 job 배지(2026-09-21) - createInstagramJob.ts가 metadata.source에
  // 남겨 둔 값을 그대로 읽는다. 일반 키워드 job은 이 필드가 없어 undefined -> null.
  const sourceTag = job.metadata?.source === "instagram_manual" ? ("instagram" as const) : null;
  const sourceUrl = sourceTag ? ((job.metadata?.instagramUrl as string | undefined) ?? null) : null;

  const entry: ManuscriptEntry = {
    title,
    searchDescription,
    slug,
    shortName,
    tags,
    body: content,
    // 뷰어와 .md 파일도 정렬된 검색어를 쓴다 - 여기가 기준 원고 순서면 화면에서 캡션과 프롬프트가
    // 어긋나 보인다(2026-09-21 사용자 리포트: 캡션 "톰포드 화보"에 프롬프트 "제작발표회").
    imagePrompts: slotPrompts,
    images,
    filePath: relative(PIPELINE_ROOT, manuscriptFilePath(date, job.keyword)),
    naver,
    sourceTag,
    sourceUrl,
  };

  await writeManuscriptFile(
    manuscriptFilePath(date, job.keyword),
    frontMatterFile({ ...entry, body: reinsertImagePrompts(entry.body, entry.imagePrompts) })
  );

  return {
    status: "success",
    imageFailures,
    topic: {
      jobId: job.id,
      keyword: job.keyword,
      category: job.category,
      date,
      readyAt: now().toISOString(),
      manuscript: entry,
    },
  };
}
