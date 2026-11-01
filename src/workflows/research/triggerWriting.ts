// 조사가 끝난 job의 집필 단계를 발화한다. runResearchStageCli(클라우드/로컬)와 맥미니 조사
// 폴러(researchPollJob)가 같은 함수를 쓴다 - 조사를 어디서 돌렸든 **집필은 Claude 그대로**다.
//
// GITHUB_TOKEN이 있으면(GH Actions 러너, 그리고 .env에 토큰이 있는 맥미니) heavy-pipeline DB 큐
// (pipelineQueue.ts)에 올려 job-write.yml을 깨우고, 없으면(로컬 수동 실행) detached 자식으로 띄운다.
//
// 2026-09-16: 예전엔 여기서 dispatchGithubWorkflow를 대기 후 직접 호출했는데(GitHub Actions
// concurrency 큐의 "대기 1개" 한도에 맞춰 최대 5분 대기), 그 대기 상한이 실제 조사 소요 시간보다
// 짧아 이 호출이 정확히 다른 job(예: "경복궁 구멍 뚫기")을 밀어내 유실시킨 원인이었다. 이제는
// GitHub 큐에 전혀 의존하지 않는 DB 큐를 거친다 - pipelineQueue.ts 상단 주석 참고.

import { spawnDetachedTask } from "../../jobs/lib/spawnDetachedTask.js";
import { warnLocalFallback } from "../../jobs/lib/warnLocalFallback.js";
import { enqueueAndMaybeDispatch } from "../../services/github/pipelineQueue.js";

export async function triggerWritingForJob(jobId: string): Promise<void> {
  if (process.env.GITHUB_TOKEN) {
    await enqueueAndMaybeDispatch({ jobId, workflowFile: "job-write.yml" });
    return;
  }
  // 토큰이 없으면 맥에서 돈다 - 맥이 잠들면 죽는다. 조용히 떨어지지 않게 알린다(2026-09-24).
  await warnLocalFallback("write", jobId);
  spawnDetachedTask("job:write", [jobId]);
}
