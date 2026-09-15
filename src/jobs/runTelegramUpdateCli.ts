// 텔레그램 webhook 릴레이(Cloudflare Worker → GitHub repository_dispatch)가 전달한 update 1건을
// 처리하는 진입점. 로컬 telegramPollJob.ts는 getUpdates로 배치를 긁어와 offset을 관리하지만,
// 여기는 이미 정해진 update 딱 1건만 받는다 - TelegramBot.processUpdate()가 그 하나를
// pollOnce()와 동일한 핸들러로 처리한다(TelegramBot.ts 최상단 "구조 원칙" 주석 참고, 수신 경로와
// 무관하게 재사용).
//
// 무거운 작업(triggerResearch/triggerWriting)은 로컬처럼 detached 프로세스로 못 띄운다 - 이 CLI가
// 도는 GH Actions 러너는 이 job이 끝나면 통째로 내려가서, 그 안에서 던진 백그라운드 프로세스도
// 같이 죽는다. 대신 job-research.yml/job-write.yml을 GitHub API(workflow_dispatch)로 새로
// 발화한다. fire-and-forget인 triggerResearch/triggerWriting 시그니처(jobId: string) => void에
// 맞추려면 dispatch 호출을 await 없이 시작해야 하지만, 그 Promise를 기다리지 않고 프로세스가
// 끝나버리면 fetch가 완료되기 전에 종료될 수 있다 - pendingDispatches에 모아뒀다가 main() 끝에서
// 반드시 기다린다.
import "dotenv/config";

import { TelegramBot } from "../notifications/TelegramBot.js";
import type { TelegramUpdate } from "../notifications/TelegramBot.js";
import { generateTitleSuggestions } from "../workflows/keyword-notification/generateTitleSuggestions.js";
import { dispatchGithubWorkflow, HEAVY_PIPELINE_WORKFLOWS } from "../services/github/dispatchWorkflow.js";

/**
 * 이 워크플로우(telegram-update.yml) 자체의 timeout-minutes가 5분이라, concurrency 대기도 그 안에서
 * 끝나야 한다 - checkout/npm ci/claude 설치에 쓰는 시간을 빼고 넉넉히 여유를 둔다(2026-09-15,
 * dispatchWorkflow.ts 상단 주석 참고 - 대기 없이 바로 디스패치하면 이미 대기 중이던 다른 원고를
 * 밀어낼 수 있다).
 */
const TELEGRAM_UPDATE_DISPATCH_MAX_WAIT_MS = 3 * 60 * 1000;

async function main(): Promise<void> {
  const raw = process.env.TELEGRAM_UPDATE_JSON;
  if (!raw) {
    throw new Error("TELEGRAM_UPDATE_JSON 환경변수가 없습니다.");
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(raw);
  } catch (error) {
    throw new Error(`TELEGRAM_UPDATE_JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pendingDispatches: Promise<void>[] = [];
  const dispatchAndTrack = (
    workflowFile: string,
    inputs: Record<string, string> = {},
    concurrencyGroupWorkflows?: string[]
  ): void => {
    const promise = dispatchGithubWorkflow({
      workflowFile,
      inputs,
      concurrencyGroupWorkflows,
      avoidEvictionMaxWaitMs: TELEGRAM_UPDATE_DISPATCH_MAX_WAIT_MS,
    }).catch((error) => {
      console.error(`⚠️ ${workflowFile} 발화 실패:`, error instanceof Error ? error.message : error);
    });
    pendingDispatches.push(promise);
  };

  const bot = TelegramBot.fromEnv({
    generateTitles: (job) =>
      generateTitleSuggestions({ keyword: job.keyword, headline: job.headline, category: job.category }),
    triggerResearch: (jobId) => dispatchAndTrack("job-research.yml", { job_id: jobId }, HEAVY_PIPELINE_WORKFLOWS),
    triggerWriting: (jobId) => dispatchAndTrack("job-write.yml", { job_id: jobId }, HEAVY_PIPELINE_WORKFLOWS),
    triggerPublishPrepare: () => dispatchAndTrack("job-publish-prepare.yml", {}, ["job-publish-prepare.yml"]),
    triggerRevision: (jobId, feedback) =>
      dispatchAndTrack("job-revise.yml", { job_id: jobId, feedback }, HEAVY_PIPELINE_WORKFLOWS),
  });

  const result = await bot.processUpdate(update);
  await Promise.all(pendingDispatches);

  if (!result.handled) {
    console.log("· [telegram-update] callback_query/message가 없는(또는 무관한) update - 무시");
    return;
  }
  console.log("✅ [telegram-update] 처리 완료:", JSON.stringify({
    hasResult: Boolean(result.result),
    hasReviewResult: Boolean(result.reviewResult),
    hasResearchDecisionResult: Boolean(result.researchDecisionResult),
    triggeredResearch: Boolean(result.researchTrigger),
    hasEditFeedbackResult: Boolean(result.editFeedbackResult),
  }));
}

main().catch((error) => {
  console.error("❌ [telegram-update] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
