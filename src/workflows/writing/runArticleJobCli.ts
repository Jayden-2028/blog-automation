// article_jobs 1건을 조사 -> 원고 생성까지 실행하는 수동 진입점.
//
// 왜 수동인가(SPRINT_2_DESIGN.md 10절 결정): 원고 1건당 비용·시간이 아직 실측되지 않았다.
// 비용이 검증되기 전에 무인 자동화는 위험하므로, 사람이 job id를 골라 직접 실행한다.
//
// 사용법:
//   npm run job:write -- <jobId>       # jobId를 알 때
//   npm run job:write                  # jobId 없이 실행하면 selected job 목록을 보여준다
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { notifyArticleReady } from "./notifyArticleReady.js";
import { runArticleJob } from "./runArticleJob.js";

async function listSelectedJobs(): Promise<void> {
  const jobs = await ArticleJobRepository.listByStatus("selected", 20);
  if (jobs.length === 0) {
    console.log("현재 status='selected'인 job이 없습니다. Telegram에서 키워드를 먼저 선택해주세요.");
    return;
  }

  console.log(`▶ status='selected' job ${jobs.length}건\n`);
  for (const job of jobs) {
    console.log(`  ${job.id}`);
    console.log(`    ${job.keyword} (${job.category ?? "N/A"}, ${job.total_score ?? "?"}점)`);
  }
  console.log(`\n실행하려면: npm run job:write -- <jobId>`);
}

async function main(): Promise<void> {
  const jobId = process.argv[2];

  if (!jobId) {
    await listSelectedJobs();
    return;
  }

  console.log(`▶ article job 실행 시작: ${jobId}`);

  const result = await runArticleJob(jobId);

  if (result.status === "skipped") {
    console.log(`⏭ 건너뜀: ${result.reason}`);
    return;
  }

  if (result.status === "failed") {
    console.error(`❌ 실패 (${result.stage} 단계): ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log("\n▶ 결과: success");
  console.log(`   조사: ${result.sources.length}건 (${Math.round(result.durationMs.research / 1000)}초)`);
  console.log(`   작성: ${Math.round(result.durationMs.writing / 1000)}초`);
  console.log(`   article #${result.article.id}: ${result.article.title}`);
  console.log(`   본문 길이: ${result.article.content?.length ?? 0}자`);
  console.log(`   의학 주제: ${result.isMedical ? "예 (사람 교차확인 필요)" : "아니오"}`);

  console.log("\n▶ Telegram 알림 발송 중...");
  await notifyArticleReady(result);
  console.log("✅ 완료 - Telegram에서 확인해주세요");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
