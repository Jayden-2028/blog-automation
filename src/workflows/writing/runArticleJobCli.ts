// article_jobs 1건의 원고 작성 단계를 실행하는 수동 진입점.
//
// 왜 수동인가(SPRINT_2_DESIGN.md 10절 결정): 원고 1건당 비용·시간이 아직 실측되지 않았다.
// 비용이 검증되기 전에 무인 자동화는 위험하므로, 사람이 job id를 골라 직접 실행한다.
//
// runWritingStage를 쓴다(runArticleJob이 아니다): job:research를 먼저 돌려 사람이 확인한 경우
// 이미 저장된 sources를 그대로 재사용해야 한다. runArticleJob은 항상 조사부터 다시 하므로 여기서
// 쓰면 검색을 두 번 하고 sources가 중복 저장된다. runWritingStage는 DB에 이미 근거가 있으면
// 재사용하고, 없으면(체크포인트를 건너뛴 경우) 알아서 조사부터 한다 - 두 경로 모두 이 한 진입점으로
// 처리된다.
//
// 사용법:
//   npm run job:write -- <jobId>       # jobId를 알 때
//   npm run job:write                  # jobId 없이 실행하면 selected/researching job 목록을 보여준다
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { notifyArticleReady } from "./notifyArticleReady.js";
import { runWritingStage } from "./runArticleJob.js";

async function listCandidateJobs(): Promise<void> {
  const [selected, researching] = await Promise.all([
    ArticleJobRepository.listByStatus("selected", 20),
    ArticleJobRepository.listByStatus("researching", 20),
  ]);

  if (selected.length === 0 && researching.length === 0) {
    console.log("현재 실행할 job이 없습니다. Telegram에서 키워드를 먼저 선택해주세요.");
    return;
  }

  if (researching.length > 0) {
    console.log(`▶ 조사 완료, 작성 대기 중(job:research를 이미 돌린 job) ${researching.length}건\n`);
    for (const job of researching) {
      console.log(`  ${job.id}`);
      console.log(`    ${job.keyword} (${job.category ?? "N/A"}, ${job.total_score ?? "?"}점)`);
    }
    console.log();
  }

  if (selected.length > 0) {
    console.log(`▶ 아직 조사 전인 job(선택만 됨) ${selected.length}건\n`);
    for (const job of selected) {
      console.log(`  ${job.id}`);
      console.log(`    ${job.keyword} (${job.category ?? "N/A"}, ${job.total_score ?? "?"}점)`);
    }
    console.log(`\n  먼저 조사만 하려면: npm run job:research -- <jobId>`);
  }

  console.log(`\n바로 작성하려면(조사부터 알아서 진행): npm run job:write -- <jobId>`);
}

async function main(): Promise<void> {
  const jobId = process.argv[2];

  if (!jobId) {
    await listCandidateJobs();
    return;
  }

  console.log(`▶ 원고 작성 시작: ${jobId}`);

  const result = await runWritingStage(jobId);

  if (result.status === "skipped") {
    console.log(`⏭ 건너뜀: ${result.reason}`);
    return;
  }

  if (result.status === "failed") {
    console.error(`❌ 실패: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log("\n▶ 결과: success");
  console.log(`   근거: ${result.sources.length}건`);
  console.log(`   작성: ${Math.round(result.durationMs / 1000)}초`);
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
