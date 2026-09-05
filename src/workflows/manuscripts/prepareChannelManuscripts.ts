// 승인된 job 1건 -> 네이버/티스토리/블로거 3채널 원고 준비 (반자동 업로드 대체, 2026-09-05).
//
// 네이버는 기준 원고를 그대로 쓰고(기존에도 배리에이션 없이 발행했다), 티스토리·블로거는 기존
// publishArticleToBlogspot.ts/publishArticleToTistory.ts 안에 있던 배리에이션 생성 로직
// (generateArticleVariant)을 발행과 분리해 이 단계에서만 돈다. Playwright/API 업로드는 하지 않는다 -
// 결과를 로컬 .md 파일로 저장해 사람이 직접 복사해 붙여넣는다.
//
// 배리에이션 article이 DB에 이미 있으면(재실행, 또는 과거 발행 시도 잔재) 재사용해 LLM 비용을
// 아낀다 - publishArticleToBlogspot.ts와 같은 이유(§주석)로, 재사용 경로에서는 searchDescription/
// slug/tags를 다시 알 수 없다(articles 테이블에 그 컬럼이 없다). 이 경우 제목만 살리고 나머지는
// 비워 둔다 - 첫 생성 때가 대부분이라 실무 영향은 작다.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { manuscriptFilePath, PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import type { ManuscriptChannel } from "../../config/pipelinePaths.js";
import {
  createArticle,
  listArticlesByJobId,
} from "../../services/supabase/repositories/articleRepository.js";
import { generateArticleVariant } from "../writing/generateArticleVariant.js";
import type { GenerateArticleVariantResult, VariantChannel } from "../writing/generateArticleVariant.js";
import type { ManuscriptChannelEntry, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

const VARIANT_CHANNELS: readonly VariantChannel[] = ["tistory", "blogspot"];

export type PrepareChannelManuscriptsResult =
  | { status: "success"; topic: ManuscriptTopicEntry }
  | { status: "failed"; reason: string };

export type PrepareChannelManuscriptsOptions = {
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  createVariantArticle?: (input: {
    jobId: string;
    channel: VariantChannel;
    title: string;
    content: string;
    aiModel: string | null;
  }) => Promise<ArticleRow>;
  generateVariant?: (input: {
    channel: VariantChannel;
    category: string | null;
    baseTitle: string;
    baseBody: string;
  }) => Promise<GenerateArticleVariantResult>;
  writeManuscriptFile?: (path: string, content: string) => Promise<void>;
  /** 테스트 주입용. 기본은 현재 시각(Asia/Seoul). */
  now?: () => Date;
};

function kstDateString(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * job.metadata.imagePrompts는 parseDraftFile.ts가 본문에서 빼낸 "[IMAGE PROMPT: ...]" 지시를
 * 등장 순서대로 담은 배열이다(runArticleJob.ts). 기준 원고와 배리에이션 모두 같은 순서로
 * "[IMAGE: 설명]" 마커를 남기므로(generateArticleVariant.ts 프롬프트 지시) 세 채널이 같은
 * imagePrompts를 공유한다 - 실제 대응은 parseManuscriptBlocks가 마커 개수와 대조해 검증한다.
 */
function readImagePrompts(job: ArticleJobRow): string[] {
  const raw = job.metadata?.imagePrompts;
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
}

function frontMatterFile(entry: Omit<ManuscriptChannelEntry, "filePath">): string {
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

export async function prepareChannelManuscripts(
  job: ArticleJobRow,
  options: PrepareChannelManuscriptsOptions = {}
): Promise<PrepareChannelManuscriptsResult> {
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const createVariantArticle =
    options.createVariantArticle ??
    (({ jobId, channel, title, content, aiModel }) =>
      createArticle({ job_id: jobId, title, content, status: "approved", ai_model: aiModel, platform: channel }));
  const generateVariant = options.generateVariant ?? ((input) => generateArticleVariant(input));
  const writeManuscriptFile = options.writeManuscriptFile ?? defaultWriteManuscriptFile;
  const now = options.now ?? (() => new Date());

  const articles = await loadArticles(job.id);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) return { status: "failed", reason: "기준 원고(네이버) 없음" };

  const date = kstDateString(now());
  const imagePrompts = readImagePrompts(job);
  const channels: ManuscriptChannelEntry[] = [
    {
      channel: "naver",
      title: baseArticle.title ?? job.keyword,
      searchDescription: null,
      slug: null,
      tags: [],
      body: baseArticle.content ?? "",
      imagePrompts,
      filePath: relative(PIPELINE_ROOT, manuscriptFilePath(date, job.keyword, "naver")),
    },
  ];

  for (const channel of VARIANT_CHANNELS) {
    const existing = [...articles].reverse().find((a) => a.platform === channel) ?? null;

    let title: string;
    let content: string;
    let searchDescription: string | null = null;
    let slug: string | null = null;
    let tags: string[] = [];

    if (existing) {
      title = existing.title ?? job.keyword;
      content = existing.content ?? "";
    } else {
      const result = await generateVariant({
        channel,
        category: job.category,
        baseTitle: baseArticle.title ?? job.keyword,
        baseBody: baseArticle.content ?? "",
      });
      if (result.status !== "success") {
        return { status: "failed", reason: `${channel} 배리에이션 실패: ${result.error}` };
      }
      title = result.variant.title;
      content = result.variant.body;
      searchDescription = result.variant.searchDescription;
      slug = result.variant.slug;
      tags = result.variant.tags;
      await createVariantArticle({ jobId: job.id, channel, title, content, aiModel: baseArticle.ai_model });
    }

    channels.push({
      channel: channel as ManuscriptChannel,
      title,
      searchDescription,
      slug,
      tags,
      body: content,
      imagePrompts,
      filePath: relative(PIPELINE_ROOT, manuscriptFilePath(date, job.keyword, channel as ManuscriptChannel)),
    });
  }

  for (const entry of channels) {
    await writeManuscriptFile(
      manuscriptFilePath(date, job.keyword, entry.channel),
      frontMatterFile(entry)
    );
  }

  return {
    status: "success",
    topic: {
      jobId: job.id,
      keyword: job.keyword,
      category: job.category,
      date,
      readyAt: now().toISOString(),
      channels,
    },
  };
}
