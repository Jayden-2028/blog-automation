// "수정 필요" 답장 피드백을 반영해 기준(네이버) 원고를 다시 쓰는 진입점(2026-09-15).
//
// TelegramBot.handleEditFeedbackMessage가 triggerRevision(jobId, feedback)으로 호출한다 - 로컬은
// spawnDetachedTask("job:revise", [jobId, feedback])로, 클라우드는 job-revise.yml을
// workflow_dispatch로 발화한다(runTelegramUpdateCli.ts).
//
// runArticleJobCli.ts와 같은 이유로 재작성 결과는 새 article row로 저장한다(같은 job의 기준
// 원고가 재작성으로 여러 건 남을 수 있다 - articleRepository.ts listArticlesByJobId 주석 참고).
// 재사용 경로(prepareChannelManuscripts.ts)는 항상 최신 platform=null row를 쓰므로 자동으로
// 이 재작성본을 기준 삼는다.
//
// 사용법:
//   npm run job:revise -- <jobId> <feedback>
import "dotenv/config";

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId, createArticle } from "../../services/supabase/repositories/articleRepository.js";
import { publishArticleToTelegraph } from "../../services/telegraph/telegraphClient.js";
import { notifyRevisedArticleReady } from "./notifyRevisedArticleReady.js";
import { reviseArticleWithFeedback } from "./reviseArticleWithFeedback.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const feedback = process.argv[3];

  if (!jobId || !feedback) {
    console.log("사용법: npm run job:revise -- <jobId> <feedback>");
    return;
  }

  console.log(`▶ 수정 반영 시작: ${jobId}`);
  console.log(`   피드백: ${feedback}`);

  const job = await ArticleJobRepository.findById(jobId);
  if (!job) {
    console.error(`❌ job을 찾을 수 없습니다: ${jobId}`);
    process.exitCode = 1;
    return;
  }

  const articles = await listArticlesByJobId(jobId);
  const baseArticle = [...articles].reverse().find((a) => a.platform === null);
  if (!baseArticle || !baseArticle.content) {
    console.error(`❌ 기준 원고를 찾을 수 없습니다: ${jobId}`);
    process.exitCode = 1;
    return;
  }

  const result = await reviseArticleWithFeedback({
    keyword: job.keyword,
    category: job.category,
    originalTitle: baseArticle.title ?? job.keyword,
    originalBody: baseArticle.content,
    feedback,
  });

  if (result.status === "failed") {
    console.error(`❌ 실패: ${result.error}`);
    await TelegramNotifier.fromEnv()
      .sendMessages([
        {
          text:
            `❌ <b>수정 반영 실패</b>\n${escapeTelegramHtml(job.keyword)}\n${escapeTelegramHtml(result.error)}\n\n` +
            `다시 시도하려면 원래 초안 메시지의 "✏️ 수정 필요"를 다시 눌러주세요.`,
        },
      ])
      .catch(() => {});
    process.exitCode = 1;
    return;
  }

  console.log(`\n▶ 결과: success (${Math.round(result.durationMs / 1000)}초)`);
  console.log(`   제목: ${result.revised.title}`);
  console.log(`   본문 길이: ${result.revised.body.length}자`);

  const newArticle = await createArticle({
    job_id: jobId,
    title: result.revised.title,
    content: result.revised.body,
    status: "review",
    ai_model: baseArticle.ai_model,
    platform: null,
  });

  const telegraphResult = await publishArticleToTelegraph(newArticle.title ?? job.keyword, result.revised.body);
  const telegraphUrl = telegraphResult.ok ? telegraphResult.url : null;
  if (!telegraphResult.ok) {
    console.error(`⚠️ Telegraph 발행 실패 (Telegram 본문 dump로 폴백) -`, telegraphResult.error);
  }

  console.log("\n▶ Telegram 알림 발송 중...");
  await notifyRevisedArticleReady(job, newArticle, feedback, telegraphUrl);
  console.log("✅ 완료 - Telegram에서 확인해주세요");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
