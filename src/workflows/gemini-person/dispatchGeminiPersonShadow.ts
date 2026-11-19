// person job이 새로 시작될 때 제미나이 그림자 **대기열 표식**(job.metadata.geminiShadow.requestedAt)만 남긴다.
// 실제 실행은 맥미니 폴러(jobs/geminiPersonPollJob.ts)가 집어 가서 agy로 한다 - 구독 로그인이 맥미니에만 있어서다.
// GitHub 워크플로를 쏘지 않는다(그래서 GITHUB_TOKEN도 필요 없다).
//
// 호출 지점은 dispatchResearch **한 곳**이다 - 핫이슈 스타 "✍️ 인물글"(pgo:)도, 인스타 인물 트랙도 결국
// 거기서 자료조사를 발화하므로 여기에 걸면 두 경로가 모두 잡힌다(새 경로가 생겨도 자동으로 따라온다).
//
// 규칙:
//  - 멱등: geminiShadow 키가 이미 있으면 다시 적지 않는다.
//  - 새 job만: status가 selected일 때만. 수정(revise)·조사 재시도(forceFreshResearch)·이미 진행 중인 job은 건너뛴다.
//  - 스위치: PERSON_GEMINI_SHADOW=false면 끈다(미설정·빈 값 = 켜짐).
//  - 이 함수는 던지지 않는다 - 기존 조사 발화를 절대 흔들지 않는다.

import { isGeminiPersonShadowEnabled } from "../../config/geminiPerson.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";
import { readGeminiShadow } from "./geminiShadowTypes.js";

export type DispatchGeminiShadowResult =
  | { dispatched: true }
  | { dispatched: false; reason: string };

export type DispatchGeminiShadowDeps = {
  isEnabled?: () => boolean;
  findJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
};

export async function dispatchGeminiPersonShadow(
  jobId: string,
  deps: DispatchGeminiShadowDeps = {}
): Promise<DispatchGeminiShadowResult> {
  try {
    if (!(deps.isEnabled ?? (() => isGeminiPersonShadowEnabled()))()) return { dispatched: false, reason: "switch_off" };
    const findJob = deps.findJob ?? ((id: string) => ArticleJobRepository.findById(id));
    const merge = deps.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch));

    const job = await findJob(jobId);
    if (!job) return { dispatched: false, reason: "job_not_found" };
    if (job.category !== "person") return { dispatched: false, reason: "not_person" };
    if (job.status !== "selected") return { dispatched: false, reason: `status_${job.status}` };
    if ((job.metadata as Record<string, unknown> | null)?.forceFreshResearch) return { dispatched: false, reason: "re_research" };
    if (readGeminiShadow(job.metadata)) return { dispatched: false, reason: "already_requested" };

    const requestedAt = (deps.now ?? (() => new Date()))().toISOString();
    await merge(jobId, { geminiShadow: { requestedAt } });
    return { dispatched: true };
  } catch (error) {
    console.warn(`⚠️ [gemini-person] 그림자 발화 실패(기존 흐름은 영향 없음): ${error instanceof Error ? error.message : String(error)}`);
    return { dispatched: false, reason: "error" };
  }
}
