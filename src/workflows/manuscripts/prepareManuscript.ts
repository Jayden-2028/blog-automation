// 승인된 job 1건 -> Blogspot 원고 1건 준비 (반자동 업로드 대체, 2026-09-05).
//
// 2026-09-15 Blogspot 단독 운영 결정(BLOGSPOT_ONLY_DESIGN.md)으로 채널 배정이 사라졌다.
// 예전에는 config/channelRouting.ts가 job.category로 티스토리/블로그스팟을 갈랐고, 배정표에
// 없는 카테고리는 실패였다. 이제 모든 원고가 Blogspot으로 간다 - 실패 경로가 하나 줄었다.
//
// 작성 단계 산출물(platform=null article)은 그 자체로 발행되지 않고 Blogspot 배리에이션을
// 만드는 재료로만 쓴다. Playwright/API 업로드는 여기서 하지 않는다 - 결과를 로컬 .md 파일로
// 저장해 사람이 뷰어에서 복사해 붙여넣는다(자동 업로드는 품질 확인 후 별도 단계).
//
// 배리에이션 article이 DB에 이미 있으면(재실행, 또는 과거 발행 시도 잔재) 재사용해 LLM 비용을
// 아낀다 - articles 테이블 자체에는 searchDescription/slug/tags 컬럼이 없어 재사용 경로에서
// article row만 봐서는 이 값들을 알 수 없다. 대신 최초 생성 시 job.metadata.channelMeta.blogspot에
// 함께 적어 두고, 재사용 시 거기서 복구한다(2026-09-15 - 태그가 재사용마다 0개로 비어 원고
// 페이지 하단 해시태그 줄이 안 나오던 문제를 사용자가 리포트해서 발견). article_jobs.metadata는
// jsonb라 마이그레이션 없이 바로 쓴다. 키 이름 `channelMeta.blogspot`은 과거 job의 값을 그대로
// 읽기 위해 유지한다(이름만 남은 화석 - 채널 개념은 없다).
//
// 이미지 자동 생성은 여기서 원고가 확정된 직후에 한 번 돈다(BLOGSPOT_ONLY_DESIGN.md §3-2) -
// 승인된 원고에만 비용을 쓰기 위해서다. best-effort라 실패해도 원고 준비는 success로 끝낸다.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { manuscriptFilePath, PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import {
  createArticle,
  listArticlesByJobId,
} from "../../services/supabase/repositories/articleRepository.js";
import { generateArticleVariant } from "../writing/generateArticleVariant.js";
import { generateNaverVariant } from "../writing/generateNaverVariant.js";
import type { GenerateNaverVariantResult } from "../writing/generateNaverVariant.js";
import type { GenerateArticleVariantResult } from "../writing/generateArticleVariant.js";
import { generateManuscriptImages } from "../images/generateManuscriptImages.js";
import { collectWebImagesForJob } from "../images/collectWebImagesForJob.js";
import { buildFallbackImagePrompts } from "../images/buildFallbackImagePrompts.js";
import type { FallbackImagePrompt } from "../images/buildFallbackImagePrompts.js";
import type { UnfilledSlot } from "../images/collectWebImages.js";
import { renderTableImagesForJob } from "../images/renderTableImagesForJob.js";
import { capturePagesForJob } from "../images/capturePagesForJob.js";
import { alignImagePrompts } from "./alignImagePrompts.js";
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
  createVariantArticle?: (input: {
    jobId: string;
    title: string;
    content: string;
    aiModel: string | null;
  }) => Promise<ArticleRow>;
  generateVariant?: (input: {
    category: string | null;
    baseTitle: string;
    baseBody: string;
  }) => Promise<GenerateArticleVariantResult>;
  writeManuscriptFile?: (path: string, content: string) => Promise<void>;
  /** 새로 생성한 배리에이션의 searchDescription/slug/tags를 job.metadata에 보존(재사용 시 복구용). */
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
  /**
   * 네이버용 배리에이션. 기본은 generateNaverVariant(Blogspot 원고를 가볍게 다시 씀).
   * false를 주면 건너뛴다(테스트 - LLM을 타면 안 된다).
   */
  generateNaverVariant?:
    | false
    | ((input: {
        category: string | null;
        blogspotTitle: string;
        blogspotBody: string;
      }) => Promise<GenerateNaverVariantResult>);
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

export async function prepareManuscript(
  job: ArticleJobRow,
  options: PrepareManuscriptOptions = {}
): Promise<PrepareManuscriptResult> {
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const createVariantArticle =
    options.createVariantArticle ??
    (({ jobId, title, content, aiModel }) =>
      createArticle({ job_id: jobId, title, content, status: "approved", ai_model: aiModel, platform: BLOGSPOT_PLATFORM }));
  const generateVariant = options.generateVariant ?? ((input) => generateArticleVariant(input));
  const writeManuscriptFile = options.writeManuscriptFile ?? defaultWriteManuscriptFile;
  const mergeJobMetadata =
    options.mergeJobMetadata ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));
  const generateImages =
    options.generateImages === undefined ? generateManuscriptImages : options.generateImages;
  const collectWebImages =
    options.collectWebImages === undefined ? collectWebImagesForJob : options.collectWebImages;
  const renderTableImages =
    options.renderTableImages === undefined ? renderTableImagesForJob : options.renderTableImages;
  const capturePages = options.capturePages === undefined ? capturePagesForJob : options.capturePages;
  const buildFallbacks =
    options.buildFallbackPrompts === undefined ? buildFallbackImagePrompts : options.buildFallbackPrompts;
  // 네이버 배리에이션은 **기본으로 끈다**(2026-09-21 사용자 결정). 채널이 Blogspot 하나인데
  // (CLAUDE.md) 원고마다 LLM 호출이 한 번 더 돌아 2~5분을 먹고 있었다. 뷰어의 네이버 복사
  // 버튼용이라 없으면 그 버튼만 숨는다(renderManuscriptPage가 naver: null을 이미 처리한다).
  // 코드는 지우지 않는다 - 네이버를 다시 쓰게 되면 NAVER_VARIANT_ENABLED=true로 되살린다.
  // 이미 만들어 둔 원고의 naverVariant는 metadata에 남아 있어 그대로 보인다.
  const naverEnabled = process.env.NAVER_VARIANT_ENABLED === "true";
  const makeNaverVariant =
    options.generateNaverVariant === undefined
      ? naverEnabled
        ? generateNaverVariant
        : false
      : options.generateNaverVariant;
  const now = options.now ?? (() => new Date());

  const articles = await loadArticles(job.id);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) return { status: "failed", reason: "기준 원고 없음" };

  const date = kstDateString(now());
  const imagePrompts = readImagePrompts(job);

  const latestVariant = [...articles].reverse().find((a) => a.platform === BLOGSPOT_PLATFORM) ?? null;
  // 수정 반영(job:revise)은 새 기준 원고 row를 **배리에이션보다 나중에** 만든다. 그 경우 기존
  // 배리에이션은 수정 전 원고에서 나온 것이라 재사용하면 사용자의 수정이 최종본에 영영 반영되지
  // 않는다 - 기준 원고가 더 새것이면 다시 만든다(2026-09-19). 평상시에는 기준 원고가 먼저이므로
  // 이 조건이 걸리지 않고 예전처럼 재사용된다(LLM 비용 0).
  const existing = latestVariant && latestVariant.id > baseArticle.id ? latestVariant : null;
  if (latestVariant && !existing) {
    console.log(`· [manuscripts] 기준 원고가 수정됐습니다(article ${baseArticle.id} > 배리에이션 ${latestVariant.id}) - 배리에이션을 다시 만듭니다.`);
  }
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
    const result = await generateVariant({
      category: job.category,
      baseTitle: baseArticle.title ?? job.keyword,
      baseBody: baseArticle.content ?? "",
    });
    if (result.status !== "success") {
      return { status: "failed", reason: `Blogspot 원고 생성 실패: ${result.error}` };
    }
    title = result.variant.title;
    content = result.variant.body;
    searchDescription = result.variant.searchDescription;
    slug = result.variant.slug;
    tags = result.variant.tags;
    shortName = result.variant.shortName;
    await createVariantArticle({ jobId: job.id, title, content, aiModel: baseArticle.ai_model });
    await mergeJobMetadata(job.id, {
      channelMeta: { ...channelMeta, [BLOGSPOT_PLATFORM]: { searchDescription, slug, tags, shortName } } satisfies ChannelMetaMap,
    });
  }

  const imageFailures: string[] = [];

  // 배리에이션이 문단을 재배열하면 마커 순서도 바뀌는데, imagePrompts는 **기준 원고 순서**로
  // 저장돼 있다. 번호로만 짝지으면 통째로 밀려 "검색은 A, 판정은 B"가 된다 - 2026-09-21 지창욱
  // 원고에서 6자리 중 5자리가 이렇게 어긋나 웹 검색이 전부 실패했다. 재배열을 막는 대신(그건
  // 배리에이션의 일이다) 설명을 보고 검색어가 제 마커를 따라가게 맞춘다.
  const aligned = alignImagePrompts(baseArticle.content ?? "", content, imagePrompts);
  const slotPrompts = aligned ? aligned.prompts : imagePrompts;
  if (aligned?.reordered) {
    console.log(`· [manuscripts] ${job.keyword}: 배리에이션이 마커를 재배열해 검색어를 다시 맞췄습니다.`);
  }
  if (aligned && aligned.unmatched.length > 0) {
    imageFailures.push(
      `기준 원고에 대응이 없는 마커 ${aligned.unmatched.join(", ")}번 - 검색어를 비웠습니다(엉뚱한 검색어를 붙이지 않기 위해).`
    );
  }

  // 이미지 생성은 원고가 확정된 뒤에만. job당 1회 - metadata.imagesReadyAt으로 멱등 처리한다.
  // 실패는 원고를 막지 않는다(images가 빈 채로 넘어가고 뷰어는 프롬프트만 보여준다).
  let images: ManuscriptImage[] = readJobManuscriptImages(job);
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
      body: content,
      imagePrompts: slotPrompts,
      filledIndexes: images.filter((i) => i.url && i.sourcePage).map((i) => i.index),
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

  // 네이버용 배리에이션(2026-09-18). 이미지 생성·수집이 끝난 **뒤에** 만든다 - 본문의 [IMAGE: ]
  // 마커를 그대로 물려받아야 같은 이미지를 쓸 수 있고, 마커는 이 시점의 content가 정본이다.
  // job당 1회(naverReadyAt)이고, 실패해도 원고는 그대로 간다(뷰어가 네이버 버튼만 숨긴다).
  let naver: { title: string; body: string; tags: string[] } | null =
    (job.metadata?.naverVariant as { title: string; body: string; tags: string[] } | undefined) ?? null;

  if (makeNaverVariant && !naver) {
    const result = await makeNaverVariant({
      category: job.category,
      blogspotTitle: title,
      blogspotBody: content,
    });
    if (result.status === "success") {
      naver = { title: result.variant.title, body: result.variant.body, tags: result.variant.tags };
      await mergeJobMetadata(job.id, { naverVariant: naver, naverReadyAt: now().toISOString() });
    } else {
      imageFailures.push(`네이버 배리에이션 실패: ${result.error}`);
    }
  }

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
