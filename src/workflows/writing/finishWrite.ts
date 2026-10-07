// job:write의 마무리 - runWritingStage 결과를 받아 다음 단계로 잇는다(PIPELINE-MERGE-2026-10.md §1-a).
// CLI(runArticleJobCli.ts)는 import 즉시 실행되는 진입점이라 분기 로직을 여기로 뺐다(테스트 가능하게).
//
//   · skipped / failed  -> 기존과 같다(failed는 write 실패 알림 + 비정상 종료). 자동 승인은 절대 일어나지 않는다.
//   · success + 게이트 켜짐 -> 자동 승인 + job-publish-prepare 발화. 초안 알림은 보내지 않는다(통합 알림이 prepare 뒤에 온다).
//   · success + 게이트 꺼짐/사용설명서 -> 옛 흐름: 초안 알림(✅/✏️/🗑).

import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import { notifierForJob } from "../../notifications/notifierForJob.js";
import { shouldSkipDraftReview } from "../../config/pipelineGate.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { autoApproveDraft } from "./autoApproveDraft.js";
import { notifyArticleReady } from "./notifyArticleReady.js";
import { notifyWriteFailed } from "./notifyWriteFailed.js";
import type { RunWritingStageResult } from "./runArticleJob.js";
import type { ArticleJobRow } from "../../types/database.js";

export type FinishWritePath = "skipped" | "failed" | "auto_approved" | "auto_approved_dispatch_failed" | "legacy_review";

export type FinishWriteDeps = {
  skipDraftReview?: (job: ArticleJobRow) => boolean;
  autoApprove?: typeof autoApproveDraft;
  notifyDraft?: typeof notifyArticleReady;
  notifyFailure?: typeof notifyWriteFailed;
  findJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  /** 준비 발화 실패 경고 발송. 기본은 job의 트랙 봇. */
  sendWarning?: (job: ArticleJobRow, text: string) => Promise<void>;
};

export async function finishWrite(
  jobId: string,
  result: RunWritingStageResult,
  deps: FinishWriteDeps = {}
): Promise<{ path: FinishWritePath; exitCode: 0 | 1 }> {
  const skipDraftReview = deps.skipDraftReview ?? ((job) => shouldSkipDraftReview(job));
  const autoApprove = deps.autoApprove ?? autoApproveDraft;
  const notifyDraft = deps.notifyDraft ?? notifyArticleReady;
  const notifyFailure = deps.notifyFailure ?? notifyWriteFailed;
  const findJob = deps.findJob ?? ((id) => ArticleJobRepository.findById(id));
  const sendWarning =
    deps.sendWarning ?? ((job, text) => notifierForJob(job).sendMessages([{ text }]).then(() => undefined));

  if (result.status === "skipped") {
    console.log(`⏭ 건너뜀: ${result.reason}`);
    return { path: "skipped", exitCode: 0 };
  }

  if (result.status === "failed") {
    console.error(`❌ 실패: ${result.error}`);
    const job = await findJob(jobId).catch(() => null);
    await notifyFailure({ id: jobId, keyword: job?.keyword ?? "(키워드를 찾지 못했습니다)", metadata: job?.metadata }, result.error).catch(() => {});
    return { path: "failed", exitCode: 1 };
  }

  console.log("\n▶ 결과: success");
  console.log(`   근거: ${result.sources.length}건`);
  console.log(`   작성: ${Math.round(result.durationMs / 1000)}초`);
  console.log(`   article #${result.article.id}: ${result.article.title}`);
  console.log(`   본문 길이: ${result.article.content?.length ?? 0}자`);
  console.log(`   의학 주제: ${result.isMedical ? "예 (사람 교차확인 필요)" : "아니오"}`);

  // 이미지가 붙은 원고는 prepare가 끝난 뒤 **통합 알림 한 번**(notifyManuscriptsReady)으로 온다.
  if (skipDraftReview(result.job)) {
    console.log("\n▶ 자동 승인 + 원고 준비 연결(초안 승인 단계 생략)...");
    const approval = await autoApprove({ jobId: result.job.id, articleId: result.article.id });
    if (approval.dispatched) {
      console.log("✅ 완료 - 이미지가 반영된 원고가 준비되면 알림이 한 번 도착합니다");
      return { path: "auto_approved", exitCode: 0 };
    }
    // 원고는 저장·승인됐고 준비 발화만 실패했다. 자동 재시도가 없으므로 사람이 알아야 한다.
    console.error(`⚠️ job-publish-prepare 발화 실패: ${approval.error}`);
    await sendWarning(
      result.job,
      `⚠️ <b>원고는 작성됐지만 이미지 준비를 시작하지 못했어요</b>\n${escapeTelegramHtml(result.job.keyword)}\n\n` +
        `GitHub Actions의 job-publish-prepare를 한 번 실행해 주세요(수동 실행하면 이어서 진행됩니다).`
    ).catch(() => {});
    return { path: "auto_approved_dispatch_failed", exitCode: 1 };
  }

  console.log("\n▶ Telegram 알림 발송 중...");
  await notifyDraft(result);
  console.log("✅ 완료 - Telegram에서 확인해주세요");
  return { path: "legacy_review", exitCode: 0 };
}
