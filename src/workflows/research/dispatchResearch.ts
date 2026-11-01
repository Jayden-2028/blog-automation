// 자료조사를 발화하는 **단 한 곳**(2026-11-01). 제공자가 모델과 실행 위치를 함께 정하므로
// (config/researchProvider.ts의 표) 발화 분기도 한 곳에 모은다 - 발화 지점이 셋(텔레그램 Go 버튼,
// 인스타 job 생성, 로컬 텔레그램 폴러)인데 각자 분기하면 한 곳만 고쳐 불변식이 깨진다.
//
// 불변식:
//   ① 맥미니는 Codex만 돌린다 - claude/gemini는 여기서 절대 맥 대기열에 올라가지 않는다.
//   ② Codex는 Actions에서 돌지 않는다 - codex면 GITHUB_TOKEN이 있어도 디스패치하지 않는다.
//
// 맥 로컬 실행(토큰 없음) 경로는 **개발용으로만** 남겨 둔다. 운영에서는 조사를 발화하는 세 지점이
// 모두 GitHub Actions(telegram-update.yml / instagram-capture)에서 돌아 GITHUB_TOKEN이 항상 있으므로
// 이 경로로 떨어지지 않는다 - 즉 운영에서 맥이 Claude 조사를 돌리는 일은 없다. 떨어지면
// warnLocalFallback이 텔레그램으로 알리므로 조용히 새지 않는다.

import { spawnDetachedTask } from "../../jobs/lib/spawnDetachedTask.js";
import { warnLocalFallback } from "../../jobs/lib/warnLocalFallback.js";
import { RESEARCH_PROVIDER } from "../../config/researchProvider.js";
import type { ResearchProvider } from "../../config/researchProvider.js";
import { enqueueAndMaybeDispatch } from "../../services/github/pipelineQueue.js";
import { requestLocalResearch } from "./localResearchQueue.js";

export type ResearchRoute =
  /** GitHub Actions job-research.yml (claude·gemini). */
  | "actions"
  /** 맥미니 폴러 대기열 (codex). */
  | "macmini-codex"
  /** 맥 로컬 detached 실행 (개발용 - 토큰 없음 + claude/gemini). */
  | "local-dev";

export type DispatchResearchResult = { route: ResearchRoute; queued: boolean; reason?: string };

export type DispatchResearchDeps = {
  provider?: ResearchProvider;
  hasGithubToken?: () => boolean;
  enqueue?: (jobId: string) => Promise<void>;
  queueLocal?: (jobId: string) => Promise<{ queued: boolean; reason?: string }>;
  spawnLocal?: (jobId: string) => void;
  warnFallback?: (jobId: string) => Promise<void>;
};

export async function dispatchResearch(jobId: string, deps: DispatchResearchDeps = {}): Promise<DispatchResearchResult> {
  const provider = deps.provider ?? RESEARCH_PROVIDER;

  if (provider === "codex") {
    // Actions로 보내지 않는다(불변식 ②) - GITHUB_TOKEN이 있든 없든 맥미니 대기열이다.
    const queueLocal = deps.queueLocal ?? ((id: string) => requestLocalResearch(id));
    const outcome = await queueLocal(jobId);
    return { route: "macmini-codex", ...outcome };
  }

  const hasToken = deps.hasGithubToken ?? (() => Boolean(process.env.GITHUB_TOKEN));
  if (hasToken()) {
    const enqueue = deps.enqueue ?? (async (id: string) => {
      await enqueueAndMaybeDispatch({ jobId: id, workflowFile: "job-research.yml" });
    });
    await enqueue(jobId);
    return { route: "actions", queued: true };
  }

  // 토큰이 없으면 맥에서 돈다 - 맥이 잠들면 죽는다. 조용히 떨어지지 않게 알린다(2026-09-24).
  await (deps.warnFallback ?? ((id: string) => warnLocalFallback("research", id)))(jobId);
  (deps.spawnLocal ?? ((id: string) => spawnDetachedTask("job:research", [id])))(jobId);
  return { route: "local-dev", queued: true };
}
