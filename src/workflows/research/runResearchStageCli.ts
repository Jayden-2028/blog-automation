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
import { enqueueAndMaybeDispatch } from "../../services/github/pipelineQueue.js";
import { spawnDetachedTask } from "../../jobs/lib/spawnDetachedTask.js";
import { warnLocalFallback } from "../../jobs/lib/warnLocalFallback.js";
import { runResearchStage } from "../writing/runArticleJob.js";

/**
 * job:write를 곧바로 이어서 발화한다. GITHUB_TOKEN이 있으면(GH Actions 러너) heavy-pipeline
 * DB 큐(pipelineQueue.ts)에 올려 job-write.yml을 깨우고, 없으면(로컬 수동 실행) 기존 방식대로
 * detached 자식으로 띄운다 - TelegramBot.ts의 triggerWriting 기본값과 같은 분기 원칙.
 *
 * 2026-09-16: 예전엔 여기서 dispatchGithubWorkflow를 대기 후 직접 호출했는데(GitHub Actions
 * concurrency 큐의 "대기 1개" 한도에 맞춰 최대 5분 대기), 그 대기 상한이 실제 조사 소요 시간보다
 * 짧아 이 호출이 정확히 다른 job(예: "경복궁 구멍 뚫기")을 밀어내 유실시킨 원인이었다. 이제는
 * GitHub 큐에 전혀 의존하지 않는 DB 큐를 거친다 - pipelineQueue.ts 상단 주석 참고.
 */
async function triggerWriting(jobId: string): Promise<void> {
  if (process.env.GITHUB_TOKEN) {
    await enqueueAndMaybeDispatch({ jobId, workflowFile: "job-write.yml" });
    return;
  }
  // 토큰이 없으면 맥에서 돈다 - 맥이 잠들면 죽는다. 조용히 떨어지지 않게 알린다(2026-09-24).
  await warnLocalFallback("write", jobId);
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
