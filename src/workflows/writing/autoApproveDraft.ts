// write 성공 직후의 **자동 승인** + 원고 준비 연결(PIPELINE-MERGE-2026-10.md §1-a).
//
// 옛 흐름: write 완료 -> 원고 완료 알림(✅/✏️/🗑) -> ✅ 콜백이 상태를 approved로 바꾸고 job-publish-prepare를 발화.
// 새 흐름: write 성공 직후 **같은 전이를 여기서 자동으로** 한다. 승인 콜백(TelegramBot.handleArticleReviewCallback의
// confirm)이 하던 일과 같되, 사람이 누른 것이 아니므로 `metadata.autoApprovedAt`으로 구분·추적한다.
//
// 상태 모델은 그대로다: review -> approved. `review`에 머무는 경로는 없다(runWritingStage가 잠깐 review로 두고
// 이 함수가 바로 approved로 올린다).
//
// 의학 주제: 옛 흐름의 ✅가 교차확인 완료를 뜻했다. 자동 승인은 사람 확인이 아니므로 `requiresMedicalReview`를
// **내리지 않는다** - 통합 알림이 ⚕️ 경고를 붙이고, 발행은 어차피 사람 버튼이다.
//
// 실패 격리: 상태 전이는 반드시 성공해야 하지만(예외 전파), 준비 발화 실패는 원고를 잃지 않는다 - 결과로 돌려줘
// 호출부가 사용자에게 알린다. 이미지 단계 실패는 prepare 쪽에서 원고를 막지 않는 기존 설계 그대로다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { dispatchGithubWorkflow } from "../../services/github/dispatchWorkflow.js";
import { updateArticleStatus } from "../../services/supabase/repositories/articleRepository.js";

export type AutoApproveDeps = {
  mergeJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  updateJobStatus?: (jobId: string, status: "approved") => Promise<unknown>;
  updateArticleStatus?: (articleId: number, status: "approved") => Promise<unknown>;
  /** 원고 준비 발화. 기본은 job-publish-prepare.yml workflow_dispatch(승인 콜백과 같은 지점). */
  dispatchPrepare?: () => Promise<void>;
  now?: () => Date;
};

export type AutoApproveResult =
  | { status: "approved"; dispatched: true }
  | { status: "approved"; dispatched: false; error: string };

async function defaultDispatchPrepare(): Promise<void> {
  await dispatchGithubWorkflow({ workflowFile: "job-publish-prepare.yml", inputs: {} });
}

export async function autoApproveDraft(
  target: { jobId: string; articleId: number },
  deps: AutoApproveDeps = {}
): Promise<AutoApproveResult> {
  const mergeJobMetadata = deps.mergeJobMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const updateJobStatus = deps.updateJobStatus ?? ((id, status) => ArticleJobRepository.updateStatus(id, status));
  const setArticleStatus = deps.updateArticleStatus ?? ((id, status) => updateArticleStatus(id, status));
  const dispatchPrepare = deps.dispatchPrepare ?? defaultDispatchPrepare;
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();

  await mergeJobMetadata(target.jobId, {
    reviewDecision: "confirmed",
    reviewedAt: timestamp,
    autoApprovedAt: timestamp,
  });
  await updateJobStatus(target.jobId, "approved");
  await setArticleStatus(target.articleId, "approved");

  try {
    await dispatchPrepare();
    return { status: "approved", dispatched: true };
  } catch (error) {
    return { status: "approved", dispatched: false, error: error instanceof Error ? error.message : String(error) };
  }
}
