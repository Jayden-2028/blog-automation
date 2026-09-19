// approved인데 아직 원고를 안 만든 job을 처리하는 폴러 (publishApprovedArticles.ts의
// 반자동 업로드를 대체, 2026-09-05). 새 job status 값을 추가하려면 article_jobs_status_check
// 마이그레이션(승인 필요)이 들어가므로, 완료 표시는 status 대신 metadata 플래그
// (channelManuscriptsReadyAt)로 한다 - status는 approved 그대로 둔다.
//
// job당 Blogspot 원고 1건만 만들지만(2026-09-15 단독 운영), 배리에이션 LLM + 이미지 생성이
// 붙어 있어 여러 job을 한 번에 처리하면 오래 걸린다. publishApprovedArticles.ts와 같은 이유로
// maxJobsPerRun 상한을 둔다. 성공한 job만 manifest에 반영하고 페이지를 한 번만 다시 그린다.
//
// 2026-09-15 재배선: 원고 준비(이미지까지) 직후 publishArticleToBlogspot을 이어서 호출한다.
// BLOGGER_ENABLED=false인 동안은 그 함수가 즉시 { ok:false, reason:"disabled" }로 아무것도 안
// 하고 돌아오므로(publishArticleToBlogspot.ts 참고) 지금 당장은 무해하다 - 나중에 사용자가
// BLOGGER_ENABLED를 켜는 순간 별도 배선 없이 바로 동작하도록 미리 연결해 둔다. best-effort라
// 실패해도 원고 준비 자체(파일/페이지/manifest)는 그대로 성공 유지 - 이미지 생성과 같은 원칙.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { prepareManuscript } from "./prepareManuscript.js";
import type { PrepareManuscriptResult } from "./prepareManuscript.js";
import { loadManifest, saveManifest, upsertTopicEntry } from "./manuscriptManifest.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";
import { renderManuscriptPage } from "./renderManuscriptPage.js";
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";
import type { DeployManuscriptsPageResult } from "./deployManuscriptsPage.js";
import { manuscriptIndexPagePath } from "../../config/pipelinePaths.js";
import { writeCostSnapshot } from "../reports/writeCostSnapshot.js";
import type { WriteCostSnapshotResult } from "../reports/writeCostSnapshot.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArticleJobRow } from "../../types/database.js";

export type JobManuscriptsResult = {
  job: ArticleJobRow;
  result: PrepareManuscriptResult;
};

export type PrepareApprovedManuscriptsOptions = {
  loadApprovedJobs?: () => Promise<ArticleJobRow[]>;
  prepareJob?: (job: ArticleJobRow) => Promise<PrepareManuscriptResult>;
  markPrepared?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  loadManifest?: () => Promise<ManuscriptManifest>;
  saveManifest?: (manifest: ManuscriptManifest) => Promise<void>;
  writePage?: (html: string) => Promise<void>;
  deploy?: () => Promise<DeployManuscriptsPageResult>;
  /** 비용 스냅샷(cost.json) 생성. 기본은 Supabase를 읽으므로 테스트에서는 반드시 주입한다. */
  writeCostSnapshot?: () => Promise<WriteCostSnapshotResult>;
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
  // "준비 안 된 것"을 DB에서 직접 거른다 - 예전엔 approved 20건을 받아 메모리에서 걸렀는데,
  // 준비까지 끝난 job이 그 20건을 채우자 새로 승인된 job이 조회 창 밖으로 밀려나 영영 처리되지
  // 않았다(ArticleJobRepository.listApprovedWithoutManuscript 주석 참고, 2026-09-16 사고).
  const loadApprovedJobs = options.loadApprovedJobs ?? (() => ArticleJobRepository.listApprovedWithoutManuscript(20));
  const prepareJob = options.prepareJob ?? ((job) => prepareManuscript(job));
  const markPrepared =
    options.markPrepared ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));
  const loadManifestFn = options.loadManifest ?? (() => loadManifest());
  const saveManifestFn = options.saveManifest ?? ((manifest: ManuscriptManifest) => saveManifest(manifest));
  const writePage = options.writePage ?? defaultWritePage;
  const deploy = options.deploy ?? (() => deployManuscriptsPage());
  const writeCostSnapshotFn = options.writeCostSnapshot ?? (() => writeCostSnapshot());
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
      // 이미지 실패는 원고 준비를 막지 않는다 - 로그로만 남겨 뒤에 사람이 알 수 있게 한다.
      for (const failure of result.imageFailures) {
        console.warn(`⚠️ [manuscripts] ${job.keyword}: ${failure}`);
      }

      // **여기서 Blogger에 올리지 않는다**(2026-09-19 사용자 결정). 전에는 준비 직후 초안으로
      // 올렸는데, 그러면 발행 버튼이 "이미 올라가 있음"에 막혀 매번 사람이 Blogger에서 수동으로
      // 공개해야 했다 - 자동 발행의 의미가 사라진다. 원고는 **원고 뷰어에서만** 보고, 실제 업로드는
      // 알림의 "🚀 블로그 발행" 버튼을 누른 그 순간에 한 번만 일어난다
      // (TelegramBot.handlePublishDecisionCallback).
    }
  }

  if (manifest) {
    await saveManifestFn(manifest);
    await writePage(renderManuscriptPage(manifest));
    // 비용 스냅샷은 배포 직전에 같은 디렉터리로 떨군다(배포 단위가 디렉터리 하나라 여기서 써야
    // 같이 올라간다). 실패해도 원고 준비·배포에는 영향이 없다.
    const costSnapshot = await writeCostSnapshotFn();
    if (costSnapshot.status === "failed") {
      console.warn(`⚠️ [manuscripts] 비용 스냅샷 생성 실패(무시하고 계속): ${costSnapshot.error}`);
    }
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
