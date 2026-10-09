// 통합 흐름(자동 승인된 job)의 ✏️ 수정 반영(PIPELINE-MERGE-2026-10.md §1-c).
//
// 이미지가 붙은 원고에 대한 수정이므로 "처음부터 다시"가 아니라 **마커 diff**로 이미지를 다룬다
// (planReviseImages): 마커 불변이면 이미지를 그대로 두고 뷰어만 다시 배포하고, 달라진 자리만 재수집한다.
// 끝나면 원고 준비(job-publish-prepare)를 발화하고, 준비가 끝나면 **통합 알림**(버튼 동일)이 재발송된다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { dispatchGithubWorkflow } from "../../services/github/dispatchWorkflow.js";
import { readImageCandidates, readImageDirectUrls, readImageRequirements } from "../images/applyImageEditRequest.js";
import { planReviseImages } from "../manuscripts/reconcileReviseImages.js";
import { readJobManuscriptImages } from "../manuscripts/manuscriptManifest.js";
import type { ReviseImagePlan } from "../manuscripts/reconcileReviseImages.js";
import type { ArticleJobRow } from "../../types/database.js";

export type ApplyUnifiedRevisionDeps = {
  mergeJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  dispatchPrepare?: () => Promise<void>;
  now?: () => Date;
};

export type ApplyUnifiedRevisionResult = {
  plan: ReviseImagePlan;
  dispatched: boolean;
  error?: string;
};

export async function applyUnifiedRevision(
  job: ArticleJobRow,
  beforeBody: string,
  afterBody: string,
  deps: ApplyUnifiedRevisionDeps = {}
): Promise<ApplyUnifiedRevisionResult> {
  const mergeJobMetadata = deps.mergeJobMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const dispatchPrepare =
    deps.dispatchPrepare ?? (async () => void (await dispatchGithubWorkflow({ workflowFile: "job-publish-prepare.yml", inputs: {} })));
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();

  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const plan = planReviseImages(beforeBody, afterBody, {
    images: readJobManuscriptImages(job),
    imagePrompts: Array.isArray(metadata.imagePrompts)
      ? metadata.imagePrompts.filter((p): p is string => typeof p === "string")
      : [],
    imageCandidates: readImageCandidates(metadata),
    imageRequirements: Object.keys(readImageRequirements(metadata)).length > 0 ? readImageRequirements(metadata) : null,
    imageDirectUrls: Object.keys(readImageDirectUrls(metadata)).length > 0 ? readImageDirectUrls(metadata) : null,
  });

  await mergeJobMetadata(job.id, {
    // 마커 불변이면 준비 완료 표식만 비운다(이미지·게이트는 그대로) - prepare가 같은 이미지로 원고만 다시 만든다.
    ...(plan.kind === "refresh" ? plan.patch : { channelManuscriptsReadyAt: null }),
    // 수정 요청 한 건이 끝났다 - 다음 ✏️를 다시 받을 수 있게 되돌린다.
    reviewDecision: "confirmed",
    editRequestMessageId: null,
    lastRevisedAt: timestamp,
    lastRevisionImages: plan.kind === "keep" ? "kept" : plan.diff.countChanged ? "tail-refreshed" : "slots-refreshed",
  });

  try {
    await dispatchPrepare();
    return { plan, dispatched: true };
  } catch (error) {
    return { plan, dispatched: false, error: error instanceof Error ? error.message : String(error) };
  }
}
