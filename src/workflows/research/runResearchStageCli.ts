// article_jobs 1건의 자료조사를 실행하는 진입점.
//
// 2026-09-15부터 조사 완료 후 "원고를 쓸까요?" 확인 없이 곧바로 집필 단계(job:write)로 자동
// 연결한다(사용자 요청 - 키워드 선택부터 초안 완성까지 사람 개입 없이 진행). verdict(ok/thin/
// blocked)와 무관하게 항상 자동 진행하기로 결정했다 - 이전엔 SPRINT_2_DESIGN.md 13절(2026-08-27,
// "경복궁 별빛야행" 사고 - 근거에 이미 마감된 이벤트라는 정보가 있었는데 3분짜리 LLM 비용을 쓴
// 뒤에야 알게 됨)로 이 체크포인트를 만들었지만, 사용자가 그 트레이드오프를 알고도 자동 진행을
// 선택했다. 대신 초안이 나온 뒤의 검수 단계(승인/수정 필요/반려)가 마지막 방어선이 된다.
//
// notifyResearchReady()/handleResearchDecisionCallback은 지우지 않고 그대로 둔다 - 다시 체크포인트가
// 필요해지면 아래 triggerWriting() 호출을 notifyResearchReady() 호출로 되돌리기만 하면 된다.
//
// 사용법:
//   npm run job:research -- <jobId>
import "dotenv/config";

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { dispatchGithubWorkflow, HEAVY_PIPELINE_WORKFLOWS } from "../../services/github/dispatchWorkflow.js";
import { spawnDetachedTask } from "../../jobs/lib/spawnDetachedTask.js";
import { runResearchStage } from "../writing/runArticleJob.js";

/**
 * job-research.yml의 timeout-minutes(25분) 안에서 도는 호출이라 job:write 대기 여유가
 * telegram-update.yml보다 크다 - 그래도 연구 자체가 오래 걸렸을 경우를 대비해 5분으로 잡는다
 * (2026-09-15, dispatchWorkflow.ts 상단 주석 참고 - 이 호출이 정확히 "경복궁 구멍 뚫기" job을
 * 밀어낸 원인이었다: 연구 완료 직후 곧바로 job-write를 디스패치하며 대기 중이던 다른 조사를
 * 취소시킴).
 */
const RESEARCH_TO_WRITE_DISPATCH_MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * job:write를 곧바로 이어서 발화한다. GITHUB_TOKEN이 있으면(GH Actions 러너) job-write.yml을
 * workflow_dispatch로 새로 발화하고, 없으면(로컬 수동 실행) 기존 방식대로 detached 자식으로 띄운다
 * - TelegramBot.ts의 triggerWriting 기본값과 같은 분기 원칙.
 */
async function triggerWriting(jobId: string): Promise<void> {
  if (process.env.GITHUB_TOKEN) {
    await dispatchGithubWorkflow({
      workflowFile: "job-write.yml",
      inputs: { job_id: jobId },
      concurrencyGroupWorkflows: HEAVY_PIPELINE_WORKFLOWS,
      avoidEvictionMaxWaitMs: RESEARCH_TO_WRITE_DISPATCH_MAX_WAIT_MS,
    });
    return;
  }
  spawnDetachedTask("job:write", [jobId]);
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.log("사용법: npm run job:research -- <jobId>");
    console.log("jobId 목록은 npm run job:write (인자 없이)로 확인할 수 있습니다.");
    return;
  }

  console.log(`▶ 자료조사 시작: ${jobId}`);

  const result = await runResearchStage(jobId);

  if (result.status === "skipped") {
    console.log(`⏭ 건너뜀: ${result.reason}`);
    return;
  }

  if (result.status === "failed") {
    console.error(`❌ 실패: ${result.error}`);
    // detached로 돌 때는 이 stderr를 아무도 안 보므로 Telegram으로도 알린다.
    await TelegramNotifier.fromEnv()
      .sendMessages([{ text: `❌ <b>자료조사 실패</b>\n${escapeTelegramHtml(result.error)}\n\n다시 시도하려면 텔레그램에서 다시 선택하거나 <code>npm run job:research -- ${jobId}</code>` }])
      .catch(() => {});
    process.exitCode = 1;
    return;
  }

  console.log(`\n▶ 결과: success (${Math.round(result.durationMs / 1000)}초, 근거 ${result.sources.length}건)`);
  console.log(`   verdict: ${result.verdict}`);
  console.log(`   등급: ${JSON.stringify(result.sourceCounts)}`);
  console.log(`   파일: ${result.researchFilePath}`);

  console.log("\n▶ 원고 작성으로 자동 연결 중...");
  await triggerWriting(jobId);
  console.log("✅ 완료 - job:write를 발화했습니다. 초안이 준비되면 Telegram으로 알림이 갑니다");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
