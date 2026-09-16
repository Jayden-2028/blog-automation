// 원고 페이지를 수동으로 만들거나 다시 그리는 진입점.
//
// 사용법:
//   npm run manuscripts:build              approved 대기열 중 아직 준비 안 된 job을 최대 3건 처리
//   npm run manuscripts:build -- <jobId>   그 job 1건만 즉시 처리(이미 준비됐어도 다시 만든다)
//   npm run manuscripts:build -- --refresh 원고는 건드리지 않고 저장된 목록으로 페이지만 다시 그려 배포
//
// --refresh가 왜 필요한가(2026-09-16 실측 사고): 페이지는 "승인된 원고를 실제로 처리할 때"만
// 다시 그려졌다(prepareApprovedManuscripts의 `if (manifest)` 분기 - 처리한 job이 0건이면 렌더도
// 배포도 건너뛴다). 그래서 09-15 15:26의 뷰어 전면 재설계가 **배포되지 않은 채** 14:53에 만들어진
// 옛 HTML이 그대로 떠 있었고, 사용자가 "화면이 그대로"라고 리포트하기 전까지 아무도 몰랐다.
// 디자인/렌더러만 바뀐 변경은 다음 원고 승인을 기다릴 이유가 없다 - 이 모드로 즉시 반영한다.
// LLM·이미지 생성을 전혀 호출하지 않으므로 비용이 들지 않고, DB 원고 데이터도 바꾸지 않는다.
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
import { writeCostSnapshot } from "../reports/writeCostSnapshot.js";

async function writePage(html: string): Promise<void> {
  const path = manuscriptIndexPagePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, "utf8");
}

/**
 * 배포 직전에 비용 스냅샷(cost.json)을 같은 디렉터리로 떨군다. 배포 단위가 디렉터리 하나라
 * 여기서 써야 함께 올라간다. best-effort - 실패해도 페이지 배포는 그대로 진행한다.
 */
async function writeCostSnapshotBeforeDeploy(): Promise<void> {
  const result = await writeCostSnapshot();
  if (result.status === "failed") {
    console.warn(`⚠️ 비용 스냅샷 생성 실패(무시하고 계속): ${result.error}`);
    return;
  }
  console.log(`✅ 비용 스냅샷 - 오늘 $${result.summary.today.costUsd} / 이번 달 $${result.summary.month.costUsd}`);
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

  await writeCostSnapshotBeforeDeploy();
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

/** 저장된 목록(manifest)만 읽어 페이지를 다시 그리고 배포한다. 원고/이미지/DB는 건드리지 않는다. */
async function refreshPage(): Promise<void> {
  console.log("▶ 저장된 원고 목록으로 페이지만 다시 그리는 중...");
  const manifest = await loadManifest();
  if (manifest.topics.length === 0) {
    console.log("⏭ 저장된 원고가 없습니다 - 그릴 내용이 없어 배포하지 않습니다.");
    return;
  }

  await writePage(renderManuscriptPage(manifest));
  console.log(`✅ 페이지 재생성 - 원고 ${manifest.topics.length}건`);
  console.log(`   열기: open ${manuscriptIndexPagePath()}`);

  await writeCostSnapshotBeforeDeploy();
  const deployResult = await deployManuscriptsPage();
  if (deployResult.status === "success") console.log(`✅ 배포 완료: ${deployResult.url}`);
  else if (deployResult.status === "failed") console.error(`⚠️ 배포 실패: ${deployResult.error}`);
  else console.log(`ℹ️ 배포 건너뜀: ${deployResult.reason}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--refresh") await refreshPage();
  else if (arg) await buildOne(arg);
  else await buildPending();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
