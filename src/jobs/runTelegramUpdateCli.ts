// 텔레그램 webhook 릴레이(Cloudflare Worker → GitHub repository_dispatch)가 전달한 update 1건을
// 처리하는 진입점. 로컬 telegramPollJob.ts는 getUpdates로 배치를 긁어와 offset을 관리하지만,
// 여기는 이미 정해진 update 딱 1건만 받는다 - TelegramBot.processUpdate()가 그 하나를
// pollOnce()와 동일한 핸들러로 처리한다(TelegramBot.ts 최상단 "구조 원칙" 주석 참고, 수신 경로와
// 무관하게 재사용).
//
// 무거운 작업(triggerResearch/triggerWriting/triggerRevision)은 로컬처럼 detached 프로세스로 못
// 띄운다 - 이 CLI가 도는 GH Actions 러너는 이 job이 끝나면 통째로 내려가서, 그 안에서 던진
// 백그라운드 프로세스도 같이 죽는다.
//
// 2026-09-16: heavy-pipeline(job-research/write/revise) 세 워크플로우는 GitHub API를 직접 부르지
// 않고 pipelineQueue.ts의 DB 큐를 거친다. GitHub Actions concurrency 큐는 "실행 중 1개 + 대기
// 1개"까지만 허용해서, 대기가 그 이상 쌓이면 조용히 취소한다 - 09-15/09-16 이틀 연속 이 경로로
// 원고가 유실됐다(대기 후 디스패치하는 이전 완화책도 대기 상한이 실제 소요 시간보다 짧아 뚫렸다).
// enqueueAndMaybeDispatch는 GitHub 큐에 전혀 의존하지 않고 우리 DB에서 순서를 직접 관리한다 -
// 몇 건이 몰리든 취소 없이 순서대로 처리된다(pipelineQueue.ts 상단 주석 참고).
//
// job-publish-prepare.yml은 heavy-pipeline이 아니다(별도 concurrency group, 충돌 이력 없음) -
// 그대로 dispatchGithubWorkflow 직접 호출을 쓴다.
import "dotenv/config";

import { TelegramBot } from "../notifications/TelegramBot.js";
import type { TelegramUpdate } from "../notifications/TelegramBot.js";
import { generateTitleSuggestions } from "../workflows/keyword-notification/generateTitleSuggestions.js";
import { dispatchGithubWorkflow } from "../services/github/dispatchWorkflow.js";
import { enqueueAndMaybeDispatch } from "../services/github/pipelineQueue.js";

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

  const enqueueHeavy = (jobId: string, workflowFile: string, extraInputs: Record<string, string> = {}): void => {
    const promise = enqueueAndMaybeDispatch({ jobId, workflowFile, inputs: extraInputs }).catch((error) => {
      console.error(`⚠️ ${workflowFile} 큐 등록 실패:`, error instanceof Error ? error.message : error);
    });
    pendingDispatches.push(promise);
  };

  const dispatchPublishPrepare = (): void => {
    const promise = dispatchGithubWorkflow({ workflowFile: "job-publish-prepare.yml", inputs: {} }).catch((error) => {
      console.error("⚠️ job-publish-prepare.yml 발화 실패:", error instanceof Error ? error.message : error);
    });
    pendingDispatches.push(promise);
  };

  const bot = TelegramBot.fromEnv({
    generateTitles: (job) =>
      generateTitleSuggestions({ keyword: job.keyword, headline: job.headline, category: job.category }),
    triggerResearch: (jobId) => enqueueHeavy(jobId, "job-research.yml"),
    triggerWriting: (jobId) => enqueueHeavy(jobId, "job-write.yml"),
    triggerPublishPrepare: () => dispatchPublishPrepare(),
    triggerRevision: (jobId, feedback) => enqueueHeavy(jobId, "job-revise.yml", { feedback }),
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
