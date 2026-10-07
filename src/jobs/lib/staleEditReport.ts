// 발행 폴러 공용 - 뷰어 수정 반영·이미지 교체가 10분 넘게 끝나지 않은 건을 경고하고 표식을 푼다(2026-10-07, VIEWER-REFINE §2-c).
// 가드(filterEditPending)는 stale이면 막지 않고 통과시킨다. 여기서는 사용자에게 "반영이 안 끝났는데 발행이 진행된다"를 알리고,
// 같은 경고가 주기마다 반복되지 않게 접수 표식을 지운다.
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { staleClearPatch } from "../../workflows/manuscripts/viewerEditGuard.js";
import type { EditPendingState } from "../../workflows/manuscripts/viewerEditGuard.js";

export type StaleEntry = { job: { id: string; keyword?: string }; state: Extract<EditPendingState, { state: "stale" }> };

const KIND_LABEL = { viewerEdit: "수정본 저장", imagePick: "이미지 교체" } as const;

export function staleWarningText(entry: StaleEntry): string {
  return [
    `⚠️ <b>${KIND_LABEL[entry.state.kind]}이 끝나지 않았습니다</b>`,
    "",
    `<b>${(entry.job.keyword ?? entry.job.id).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>`,
    "10분 넘게 반영 완료 기록이 없어 실패로 보고 발행을 진행합니다. 방금 고친 내용이 빠졌을 수 있으니 발행본을 확인하세요(GitHub Actions의 manuscript-edit·image-pick 실행 기록을 보면 원인이 나옵니다).",
  ].join("\n");
}

export async function reportStaleEdits(
  stale: StaleEntry[],
  notify: (job: { id: string; keyword?: string }, text: string) => Promise<void>,
  clear: (jobId: string, patch: Record<string, unknown>) => Promise<unknown> = (id, patch) => ArticleJobRepository.mergeMetadata(id, patch)
): Promise<void> {
  for (const entry of stale) {
    console.warn(`⚠️ ${entry.job.keyword ?? entry.job.id}: ${KIND_LABEL[entry.state.kind]}이 ${entry.state.since}부터 끝나지 않음 - 막지 않고 진행`);
    await notify(entry.job, staleWarningText(entry)).catch(() => {});
    await clear(entry.job.id, staleClearPatch(entry.state.kind)).catch(() => {});
  }
}
