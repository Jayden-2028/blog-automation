// "수정 필요" 답장 피드백을 반영해 기준(네이버) 원고를 다시 쓰는 진입점(2026-09-15).
//
// TelegramBot.handleEditFeedbackMessage가 triggerRevision(jobId, feedback)으로 호출한다 - 로컬은
// spawnDetachedTask("job:revise", [jobId, feedback])로, 클라우드는 job-revise.yml을
// workflow_dispatch로 발화한다(runTelegramUpdateCli.ts).
//
// runArticleJobCli.ts와 같은 이유로 재작성 결과는 새 article row로 저장한다(같은 job의 기준
// 원고가 재작성으로 여러 건 남을 수 있다 - articleRepository.ts listArticlesByJobId 주석 참고).
// 재사용 경로(prepareManuscript.ts)는 항상 최신 platform=null row를 쓰므로 자동으로
// 이 재작성본을 기준 삼는다.
//
// 사용법:
//   npm run job:revise -- <jobId> <feedback>
import "dotenv/config";

import { shouldSkipDraftReview } from "../../config/pipelineGate.js";
import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import { notifierForJob, notifierForJobId } from "../../notifications/notifierForJob.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { dispatchGithubWorkflow } from "../../services/github/dispatchWorkflow.js";
import { listArticlesByJobId, createArticle } from "../../services/supabase/repositories/articleRepository.js";
import { publishArticleToTelegraph } from "../../services/telegraph/telegraphClient.js";
import { applyUnifiedRevision } from "./applyUnifiedRevision.js";
import { notifyRevisedArticleReady } from "./notifyRevisedArticleReady.js";
import { reviseArticleWithFeedback } from "./reviseArticleWithFeedback.js";
import type { ArticleJobRow } from "../../types/database.js";

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
    await notifierForJob(job)
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

  // 통합 흐름(자동 승인된 job)이면 수정본도 곧바로 approved다 - 초안 검수 대기로 되돌리지 않는다.
  const unified = shouldSkipDraftReview(job) && job.status === "approved";

  const newArticle = await createArticle({
    job_id: jobId,
    title: result.revised.title,
    content: result.revised.body,
    status: unified ? "approved" : "review",
    ai_model: baseArticle.ai_model,
    platform: null,
  });

  // 통합 흐름: 마커 diff로 이미지를 유지/부분 갱신하고 원고 준비를 다시 돌린다(전체 재실행 아님).
  if (unified) {
    await reviseUnified(job, baseArticle.content, result.revised.body);
    return;
  }

  // 이미 최종 원고까지 만들어진(=승인된) job이면 초안 검수로 되돌리지 않는다 - 사용자가 최종본을
  // 보고 고쳐달라고 한 것이므로, 바로 최종본을 다시 만들어 발행 버튼과 함께 재전송한다
  // (2026-09-19 사용자 요청: "이미 승인된 초안이라도 다시 수정하면 반영해서 최종안을 재전송").
  if (job.metadata?.channelManuscriptsReadyAt) {
    await rePrepareFinalManuscript(jobId, job.keyword);
    return;
  }

  const telegraphResult = await publishArticleToTelegraph(newArticle.title ?? job.keyword, result.revised.body);
  const telegraphUrl = telegraphResult.ok ? telegraphResult.url : null;
  if (!telegraphResult.ok) {
    console.error(`⚠️ Telegraph 발행 실패 (Telegram 본문 dump로 폴백) -`, telegraphResult.error);
  }

  console.log("\n▶ Telegram 알림 발송 중...");
  await notifyRevisedArticleReady(job, newArticle, feedback, telegraphUrl);
  console.log("✅ 완료 - Telegram에서 확인해주세요");
}


/** 통합 흐름의 수정 반영. 이미지는 마커 diff에 따라 유지하거나 달라진 자리만 갱신한다(PIPELINE-MERGE §1-c). */
async function reviseUnified(job: ArticleJobRow, beforeBody: string, afterBody: string): Promise<void> {
  const outcome = await applyUnifiedRevision(job, beforeBody, afterBody);

  const imageLine =
    outcome.plan.kind === "keep"
      ? "이미지는 그대로 두고 원고만 다시 만듭니다."
      : outcome.plan.diff.countChanged
        ? `이미지 마커가 바뀌어 ${outcome.plan.changedIndexes[0]}번 자리부터 다시 구합니다(앞쪽 이미지는 유지).`
        : `이미지 마커가 바뀐 ${outcome.plan.changedIndexes.join(", ")}번 자리만 다시 구합니다(나머지는 유지).`;

  await (await notifierForJobId(job.id))
    .sendMessages([
      {
        text:
          `🔄 <b>수정을 반영했습니다</b>\n${escapeTelegramHtml(job.keyword)}\n\n${imageLine}\n` +
          (outcome.dispatched
            ? "완료되면 발행 버튼과 함께 다시 보내드립니다."
            : "⚠️ 원고 준비 발화에 실패했습니다. GitHub Actions의 job-publish-prepare를 수동 실행해 주세요."),
      },
    ])
    .catch(() => {});

  if (!outcome.dispatched) {
    console.error(`⚠️ job-publish-prepare.yml 발화 실패: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 완료 - 원고를 다시 만듭니다(job-publish-prepare). 이미지: ${outcome.plan.kind}`);
}

/**
 * 승인 이후 수정이 들어온 job을, 최종 원고 준비 단계로 되돌린다.
 *
 * 여는 게이트와 그 이유:
 *  - `channelManuscriptsReadyAt` - 이게 있으면 job이 준비 대상에서 빠진다(가장 바깥 게이트).
 *  - `images` / `imagesReadyAt` / `webImagesReadyAt` - 이미지는 본문의 **마커 순번**으로 원고와
 *    짝지어진다(parseManuscriptBlocks). 본문이 바뀌면 순번이 밀려 엉뚱한 자리에 붙으므로 비운다.
 *    사용자의 수정 요청 자체가 이미지 교체인 경우도 많다.
 *  - `naverReadyAt` - 네이버 배리에이션도 수정 전 본문에서 나온 것이라 다시 만든다.
 *
 * 배리에이션 article row는 지우지 않는다 - prepareManuscript가 "기준 원고가 배리에이션보다
 * 새것이면 다시 만든다"로 알아서 판단한다(row를 지우면 발행 이력 추적이 끊긴다).
 */
async function rePrepareFinalManuscript(jobId: string, keyword: string): Promise<void> {
  await ArticleJobRepository.mergeMetadata(jobId, {
    channelManuscriptsReadyAt: null,
    images: [],
    imagesReadyAt: null,
    webImagesReadyAt: null,
    naverReadyAt: null,
  });

  const dispatched = await dispatchGithubWorkflow({ workflowFile: "job-publish-prepare.yml", inputs: {} })
    .then(() => true)
    .catch((error) => {
      console.error("⚠️ job-publish-prepare.yml 발화 실패:", error instanceof Error ? error.message : error);
      return false;
    });

  await (await notifierForJobId(jobId))
    .sendMessages([
      {
        text:
          `🔄 <b>수정을 반영했습니다</b>\n${escapeTelegramHtml(keyword)}\n\n` +
          (dispatched
            ? "최종 원고와 이미지를 다시 만들고 있습니다. 완료되면 발행 버튼과 함께 다시 보내드립니다."
            : "최종 원고 재생성 발화에 실패했습니다. 다음 준비 실행에서 자동으로 처리됩니다."),
      },
    ])
    .catch(() => {});

  console.log("✅ 완료 - 최종 원고를 다시 만듭니다(job-publish-prepare).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
