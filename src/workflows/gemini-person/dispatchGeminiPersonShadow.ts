// person job이 새로 시작될 때 제미나이 그림자 실행(job-gemini-person.yml)을 발화한다.
//
// 호출 지점은 dispatchResearch **한 곳**이다 - 핫이슈 스타 "✍️ 인물글"(pgo:)도, 인스타 인물 트랙도 결국
// 거기서 자료조사를 발화하므로 여기에 걸면 두 경로가 모두 잡힌다(새 경로가 생겨도 자동으로 따라온다).
//
// 규칙:
//  - heavy-pipeline 큐(pipelineQueue)를 **타지 않는다**. API만 부르는 가벼운 job이라 집필·조사 줄에 세우면 서로를 막는다.
//    그래서 enqueueAndMaybeDispatch가 아니라 dispatchGithubWorkflow로 직접 쏜다(job별 concurrency는 yml이 맡는다).
//  - 멱등: job.metadata.geminiShadow.requestedAt이 있으면 다시 쏘지 않는다. 발화 직전에 그 키를 먼저 적는다.
//  - 새 job만: status가 selected일 때만. 수정(revise)·조사 재시도(forceFreshResearch)·이미 진행 중인 job은 건너뛴다.
//  - 스위치: repo variable PERSON_GEMINI_SHADOW=false면 끈다(미설정·빈 값 = 켜짐).
//  - 이 함수는 던지지 않는다 - 기존 조사 발화를 절대 흔들지 않는다.

import { isGeminiPersonShadowEnabled } from "../../config/geminiPerson.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { dispatchGithubWorkflow } from "../../services/github/dispatchWorkflow.js";
import type { ArticleJobRow } from "../../types/database.js";
import { readGeminiShadow } from "./geminiShadowTypes.js";

export const GEMINI_PERSON_WORKFLOW_FILE = "job-gemini-person.yml";

export type DispatchGeminiShadowResult =
  | { dispatched: true }
  | { dispatched: false; reason: string };

export type DispatchGeminiShadowDeps = {
  isEnabled?: () => boolean;
  hasGithubToken?: () => boolean;
  findJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  dispatch?: (jobId: string) => Promise<void>;
  now?: () => Date;
};

export async function dispatchGeminiPersonShadow(
  jobId: string,
  deps: DispatchGeminiShadowDeps = {}
): Promise<DispatchGeminiShadowResult> {
  try {
    if (!(deps.isEnabled ?? (() => isGeminiPersonShadowEnabled()))()) return { dispatched: false, reason: "switch_off" };
    // 토큰이 없으면(맥 로컬 개발 경로) 쏠 곳이 없다. 키를 먼저 적지 않아야 나중에 다시 시도할 수 있다.
    if (!(deps.hasGithubToken ?? (() => Boolean(process.env.GITHUB_TOKEN)))()) return { dispatched: false, reason: "no_github_token" };

    const findJob = deps.findJob ?? ((id: string) => ArticleJobRepository.findById(id));
    const merge = deps.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch));
    const dispatch =
      deps.dispatch ?? ((id: string) => dispatchGithubWorkflow({ workflowFile: GEMINI_PERSON_WORKFLOW_FILE, inputs: { job_id: id } }));

    const job = await findJob(jobId);
    if (!job) return { dispatched: false, reason: "job_not_found" };
    if (job.category !== "person") return { dispatched: false, reason: "not_person" };
    if (job.status !== "selected") return { dispatched: false, reason: `status_${job.status}` };
    if ((job.metadata as Record<string, unknown> | null)?.forceFreshResearch) return { dispatched: false, reason: "re_research" };
    if (readGeminiShadow(job.metadata)) return { dispatched: false, reason: "already_requested" };

    const requestedAt = (deps.now ?? (() => new Date()))().toISOString();
    await merge(jobId, { geminiShadow: { requestedAt } });
    try {
      await dispatch(jobId);
    } catch (error) {
      // 쏘지 못했으면 키를 지워 다음 기회(같은 job의 다른 발화)에 다시 시도할 수 있게 한다. null = 키 삭제.
      await merge(jobId, { geminiShadow: null }).catch(() => {});
      throw error;
    }
    return { dispatched: true };
  } catch (error) {
    console.warn(`⚠️ [gemini-person] 그림자 발화 실패(기존 흐름은 영향 없음): ${error instanceof Error ? error.message : String(error)}`);
    return { dispatched: false, reason: "error" };
  }
}
