// approved인데 아직 채널 원고를 안 만든 job을 fan-out하는 폴러 (publishApprovedArticles.ts의
// 반자동 업로드를 대체, 2026-09-05). 새 job status 값을 추가하려면 article_jobs_status_check
// 마이그레이션(승인 필요)이 들어가므로, 완료 표시는 status 대신 metadata 플래그
// (channelManuscriptsReadyAt)로 한다 - status는 approved 그대로 둔다.
//
// job당 배리에이션 LLM을 최대 2회(티스토리·블로거) 돌리므로 publishApprovedArticles.ts와 같은
// 이유로 maxJobsPerRun 상한을 둔다. 성공한 job만 manifest에 반영하고 페이지를 한 번만 다시 그린다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { prepareChannelManuscripts } from "./prepareChannelManuscripts.js";
import type { PrepareChannelManuscriptsResult } from "./prepareChannelManuscripts.js";
import { loadManifest, saveManifest, upsertTopicEntry } from "./manuscriptManifest.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";
import { renderManuscriptPage } from "./renderManuscriptPage.js";
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";
import type { DeployManuscriptsPageResult } from "./deployManuscriptsPage.js";
import { manuscriptIndexPagePath } from "../../config/pipelinePaths.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArticleJobRow } from "../../types/database.js";

export type JobManuscriptsResult = {
  job: ArticleJobRow;
  result: PrepareChannelManuscriptsResult;
};

export type PrepareApprovedManuscriptsOptions = {
  loadApprovedJobs?: () => Promise<ArticleJobRow[]>;
  prepareJob?: (job: ArticleJobRow) => Promise<PrepareChannelManuscriptsResult>;
  markPrepared?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  loadManifest?: () => Promise<ManuscriptManifest>;
  saveManifest?: (manifest: ManuscriptManifest) => Promise<void>;
  writePage?: (html: string) => Promise<void>;
  deploy?: () => Promise<DeployManuscriptsPageResult>;
  /** job당 처리 상한(배리에이션 LLM 호출이 오래 걸리므로). 기본 3. */
  maxJobsPerRun?: number;
};

async function defaultWritePage(html: string): Promise<void> {
  const path = manuscriptIndexPagePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, "utf8");
}

export async function prepareApprovedManuscripts(
  options: PrepareApprovedManuscriptsOptions = {}
): Promise<JobManuscriptsResult[]> {
  const loadApprovedJobs = options.loadApprovedJobs ?? (() => ArticleJobRepository.listByStatus("approved", 20));
  const prepareJob = options.prepareJob ?? ((job) => prepareChannelManuscripts(job));
  const markPrepared =
    options.markPrepared ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));
  const loadManifestFn = options.loadManifest ?? (() => loadManifest());
  const saveManifestFn = options.saveManifest ?? ((manifest: ManuscriptManifest) => saveManifest(manifest));
  const writePage = options.writePage ?? defaultWritePage;
  const deploy = options.deploy ?? (() => deployManuscriptsPage());
  const maxJobsPerRun = options.maxJobsPerRun ?? 3;

  const approved = await loadApprovedJobs();
  const pending = approved.filter((job) => !job.metadata?.channelManuscriptsReadyAt).slice(0, maxJobsPerRun);

  const results: JobManuscriptsResult[] = [];
  let manifest: ManuscriptManifest | null = null;

  for (const job of pending) {
    const result = await prepareJob(job);
    results.push({ job, result });

    if (result.status === "success") {
      manifest ??= await loadManifestFn();
      manifest = upsertTopicEntry(manifest, result.topic);
      await markPrepared(job.id, { channelManuscriptsReadyAt: result.topic.readyAt });
    }
  }

  if (manifest) {
    await saveManifestFn(manifest);
    await writePage(renderManuscriptPage(manifest));
    // 배포는 부가 기능이다 - 실패해도 원고 준비 자체(위 results)는 그대로 success 유지.
    // Cloudflare 미설정이면 조용히 skipped를 돌려준다(deployManuscriptsPage.ts).
    const deployResult = await deploy();
    if (deployResult.status === "failed") {
      console.error(`⚠️ [manuscripts] 페이지 배포 실패: ${deployResult.error}`);
    } else if (deployResult.status === "success") {
      console.log(`✅ [manuscripts] 페이지 배포 완료: ${deployResult.url}`);
    }
  }

  return results;
}
