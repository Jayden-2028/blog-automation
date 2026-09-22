// 인스타 job이 만들어지면 자료조사를 곧바로 발화한다(2026-09-22).
//
// 왜 필요한가: 텔레그램으로 URL을 보낸 뒤부터 원고 초안이 도착할 때까지는 사람 개입이 없어야
// 한다(사용자 요구). 기존 파이프라인은 이미 조사 -> 집필 -> 초안 알림이 자동으로 이어지는데
// (runResearchStageCli.ts, 2026-09-15부터 조사 체크포인트 폐지), 인스타 job만 그 사슬의 **첫
// 고리**가 비어 있었다 - 키워드 job은 텔레그램 "Go" 버튼이 job-research.yml을 깨우지만 인스타
// job은 그 알림 자체가 없다. 그래서 job이 status=selected로 만들어진 채 아무도 집어가지 않았다.
//
// 분기 원칙은 runResearchStageCli.ts의 triggerWriting과 같다: GH Actions 러너면 heavy-pipeline
// DB 큐에 올리고(동시 실행 순서를 그쪽이 관리한다), 맥 로컬이면 detached 자식으로 띄운다.

import { spawnDetachedTask } from "../../jobs/lib/spawnDetachedTask.js";
import { enqueueAndMaybeDispatch } from "../../services/github/pipelineQueue.js";

export async function triggerResearchForJob(jobId: string): Promise<void> {
  if (process.env.GITHUB_TOKEN) {
    await enqueueAndMaybeDispatch({ jobId, workflowFile: "job-research.yml" });
    return;
  }
  spawnDetachedTask("job:research", [jobId]);
}
