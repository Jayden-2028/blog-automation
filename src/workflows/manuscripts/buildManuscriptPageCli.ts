// 채널별 원고 페이지를 수동으로 만들거나 다시 그리는 진입점.
//
// 사용법:
//   npm run manuscripts:build              approved 대기열 중 아직 준비 안 된 job을 최대 3건 처리
//   npm run manuscripts:build -- <jobId>   그 job 1건만 즉시 처리(이미 준비됐어도 다시 만든다)
import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { manuscriptIndexPagePath } from "../../config/pipelinePaths.js";
import { loadManifest, saveManifest, upsertTopicEntry } from "./manuscriptManifest.js";
import { prepareApprovedManuscripts } from "./prepareApprovedManuscripts.js";
import { prepareManuscript } from "./prepareManuscript.js";
import { renderManuscriptPage } from "./renderManuscriptPage.js";
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";

async function writePage(html: string): Promise<void> {
  const path = manuscriptIndexPagePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, "utf8");
}

async function buildOne(jobId: string): Promise<void> {
  const job = await ArticleJobRepository.findById(jobId);
  if (!job) {
    console.log(`⏭ job을 찾을 수 없습니다: ${jobId}`);
    return;
  }
  if (job.status !== "approved") {
    console.log(`⏭ job 상태가 approved가 아닙니다(현재: ${job.status}) - 원고를 승인한 뒤 실행하세요.`);
    return;
  }

  console.log(`▶ 원고 준비: ${job.keyword}`);
  const result = await prepareManuscript(job);
  if (result.status === "failed") {
    console.error(`❌ 실패: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  const manifest = upsertTopicEntry(await loadManifest(), result.topic);
  await saveManifest(manifest);
  await writePage(renderManuscriptPage(manifest));
  await ArticleJobRepository.mergeMetadata(job.id, { channelManuscriptsReadyAt: result.topic.readyAt });

  console.log(`✅ 준비 완료 - 이미지 ${result.topic.manuscript.images.length}장`);
  console.log(`   열기: open ${manuscriptIndexPagePath()}`);

  const deployResult = await deployManuscriptsPage();
  if (deployResult.status === "success") console.log(`✅ 배포 완료: ${deployResult.url}`);
  else if (deployResult.status === "failed") console.error(`⚠️ 배포 실패: ${deployResult.error}`);
  else console.log(`ℹ️ 배포 건너뜀: ${deployResult.reason}`);
}

async function buildPending(): Promise<void> {
  console.log("▶ approved 대기열에서 원고 준비 중...");
  const results = await prepareApprovedManuscripts();
  if (results.length === 0) {
    console.log("대기 중인 job 없음(모두 준비 완료거나 approved 없음)");
    return;
  }
  for (const { job, result } of results) {
    if (result.status === "success") console.log(`✅ ${job.keyword} - 이미지 ${result.topic.manuscript.images.length}장`);
    else console.log(`❌ ${job.keyword} - ${result.reason}`);
  }
  console.log(`\n열기: open ${manuscriptIndexPagePath()}`);
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (jobId) await buildOne(jobId);
  else await buildPending();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
