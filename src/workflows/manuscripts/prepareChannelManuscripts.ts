// 승인된 job 1건 -> 배정된 채널(티스토리 또는 블로그스팟) 원고 1건 준비 (반자동 업로드 대체,
// 2026-09-05; 채널 전담제 개편 2026-09-07).
//
// 채널은 job.category로 정해진다(config/channelRouting.ts) - 사회 이슈는 티스토리, 연예·OTT는
// 블로그스팟, 커뮤니티 화제는 키워드 내용으로 둘 중 하나. 배정표에 없는 카테고리(육아 등)면 실패
// 처리한다 - 육아는 애초에 수집 단계에서 걸러지므로(config/keywordExclusionRules.ts) 정상 운영에서는
// 도달하지 않지만, 과거에 이미 만들어진 job 등을 방어적으로 처리한다.
//
// 네이버는 이번 개편에서 완전히 뺐다(사용자가 별도 프로세스로 재설계 예정, 2026-09-07) - 작성 단계
// 산출물(platform=null article, 예전에 "네이버 기준 원고"라 부르던 것)은 여전히 존재하지만 그 자체로
// 채널이 되지는 않고, 배정된 채널의 배리에이션을 만드는 재료로만 쓴다.
//
// 기존 publishArticleToBlogspot.ts/publishArticleToTistory.ts 안에 있던 배리에이션 생성 로직
// (generateArticleVariant)을 발행과 분리해 이 단계에서만 돈다. Playwright/API 업로드는 하지 않는다 -
// 결과를 로컬 .md 파일로 저장해 사람이 직접 복사해 붙여넣는다.
//
// 배리에이션 article이 DB에 이미 있으면(재실행, 또는 과거 발행 시도 잔재) 재사용해 LLM 비용을
// 아낀다 - publishArticleToBlogspot.ts와 같은 이유(§주석)로, articles 테이블 자체에는
// searchDescription/slug/tags 컬럼이 없어 재사용 경로에서 article row만 봐서는 이 값들을 알 수
// 없다. 대신 최초 생성 시 job.metadata.channelMeta.<channel>에 함께 적어 두고, 재사용 시 거기서
// 복구한다(2026-09-15 - 태그가 재사용마다 0개로 비어 원고 페이지 하단 해시태그 줄이 안 나오던
// 문제를 사용자가 리포트해서 발견). article_jobs.metadata는 jsonb라 마이그레이션 없이 바로 쓴다.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { resolvePublishChannel } from "../../config/channelRouting.js";
import { manuscriptFilePath, PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import {
  createArticle,
  listArticlesByJobId,
} from "../../services/supabase/repositories/articleRepository.js";
import { generateArticleVariant } from "../writing/generateArticleVariant.js";
import type { GenerateArticleVariantResult, VariantChannel } from "../writing/generateArticleVariant.js";
import type { ManuscriptChannelEntry, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

/** job.metadata.channelMeta.<channel>에 저장하는 형태 - articles 테이블에 없는 필드를 보존한다. */
type ChannelMetaEntry = { searchDescription: string | null; slug: string | null; tags: string[] };
type ChannelMetaMap = Partial<Record<VariantChannel, ChannelMetaEntry>>;

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
  /** 새로 생성한 채널 배리에이션의 searchDescription/slug/tags를 job.metadata에 보존(재사용 시 복구용). */
  mergeJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
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
 * "[IMAGE: 설명]" 마커를 남기므로(generateArticleVariant.ts 프롬프트 지시) 배정된 채널도 같은
 * imagePrompts를 그대로 쓴다 - 실제 대응은 parseManuscriptBlocks가 마커 개수와 대조해 검증한다.
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
  const mergeJobMetadata =
    options.mergeJobMetadata ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));
  const now = options.now ?? (() => new Date());

  const channel = resolvePublishChannel(job.category, job.keyword);
  if (!channel) {
    return { status: "failed", reason: `채널 배정 불가 (category: ${job.category ?? "없음"})` };
  }

  const articles = await loadArticles(job.id);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) return { status: "failed", reason: "기준 원고 없음" };

  const date = kstDateString(now());
  const imagePrompts = readImagePrompts(job);

  const existing = [...articles].reverse().find((a) => a.platform === channel) ?? null;
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
    const saved = channelMeta[channel];
    if (saved) {
      searchDescription = saved.searchDescription;
      slug = saved.slug;
      tags = saved.tags;
    }
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
    await mergeJobMetadata(job.id, {
      channelMeta: { ...channelMeta, [channel]: { searchDescription, slug, tags } } satisfies ChannelMetaMap,
    });
  }

  const entry: ManuscriptChannelEntry = {
    channel,
    title,
    searchDescription,
    slug,
    tags,
    body: content,
    imagePrompts,
    filePath: relative(PIPELINE_ROOT, manuscriptFilePath(date, job.keyword, channel)),
  };

  await writeManuscriptFile(
    manuscriptFilePath(date, job.keyword, channel),
    frontMatterFile({ ...entry, body: reinsertImagePrompts(entry.body, entry.imagePrompts) })
  );

  return {
    status: "success",
    topic: {
      jobId: job.id,
      keyword: job.keyword,
      category: job.category,
      date,
      readyAt: now().toISOString(),
      channels: [entry],
    },
  };
}
