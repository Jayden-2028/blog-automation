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
import type { GenerateArticleVariantResult } from "../writing/generateArticleVariant.js";
import { generateManuscriptImages } from "../images/generateManuscriptImages.js";
import { readJobManuscriptImages } from "./manuscriptManifest.js";
import type { ManuscriptEntry, ManuscriptImage, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

/** platform 컬럼 값이자 metadata.channelMeta의 키. 채널 개념은 없지만 과거 행 호환으로 유지한다. */
export const BLOGSPOT_PLATFORM = "blogspot";

/** job.metadata.channelMeta.blogspot에 저장하는 형태 - articles 테이블에 없는 필드를 보존한다. */
type ChannelMetaEntry = { searchDescription: string | null; slug: string | null; tags: string[] };
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
  const now = options.now ?? (() => new Date());

  const articles = await loadArticles(job.id);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) return { status: "failed", reason: "기준 원고 없음" };

  const date = kstDateString(now());
  const imagePrompts = readImagePrompts(job);

  const existing = [...articles].reverse().find((a) => a.platform === BLOGSPOT_PLATFORM) ?? null;
  const channelMeta = (job.metadata?.channelMeta as ChannelMetaMap | undefined) ?? {};

  let title: string;
  let content: string;
  let searchDescription: string | null = null;
  let slug: string | null = null;
  let tags: string[] = [];

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
    await createVariantArticle({ jobId: job.id, title, content, aiModel: baseArticle.ai_model });
    await mergeJobMetadata(job.id, {
      channelMeta: { ...channelMeta, [BLOGSPOT_PLATFORM]: { searchDescription, slug, tags } } satisfies ChannelMetaMap,
    });
  }

  // 이미지 생성은 원고가 확정된 뒤에만. job당 1회 - metadata.imagesReadyAt으로 멱등 처리한다.
  // 실패는 원고를 막지 않는다(images가 빈 채로 넘어가고 뷰어는 프롬프트만 보여준다).
  let images: ManuscriptImage[] = readJobManuscriptImages(job);
  const imageFailures: string[] = [];
  if (generateImages && images.length === 0 && !job.metadata?.imagesReadyAt) {
    const outcome = await generateImages({
      jobId: job.id,
      keyword: job.keyword,
      date,
      body: content,
      imagePrompts,
    });
    images = outcome.images;
    imageFailures.push(...outcome.failures);
    if (images.length > 0) {
      await mergeJobMetadata(job.id, { imagesReadyAt: now().toISOString(), images });
    }
  }

  const entry: ManuscriptEntry = {
    title,
    searchDescription,
    slug,
    tags,
    body: content,
    imagePrompts,
    images,
    filePath: relative(PIPELINE_ROOT, manuscriptFilePath(date, job.keyword)),
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
