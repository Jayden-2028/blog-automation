// article_jobs 1건을 "가치 없음"으로 중단하는 공통 로직. rejectJobCli.ts(터미널)와
// TelegramBot의 research:reject 콜백(2026-08-28 추가) 양쪽에서 이 함수 하나만 쓴다 - 두 경로가
// 각자 status/메타데이터 갱신 로직을 따로 들고 있으면 한쪽만 고쳐질 위험이 있다.
//
// 왜 기록을 남기는가(SPRINT_2_DESIGN.md 13-3절 ④): 사전 확인 체크포인트에서 중단을 선택한
// 이력이 곧 "어떤 키워드 패턴이 가치가 낮은지"를 판단할 데이터가 된다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";

const NON_REJECTABLE_STATUSES: readonly ArticleJobRow["status"][] = ["approved", "published", "rejected"];

export type RejectArticleJobResult =
  | { status: "not_found" }
  | { status: "already_final"; job: ArticleJobRow }
  | { status: "rejected"; job: ArticleJobRow };

export async function rejectArticleJob(
  jobId: string,
  reason: string,
  via: "cli" | "telegram"
): Promise<RejectArticleJobResult> {
  const job = await ArticleJobRepository.findById(jobId);
  if (!job) return { status: "not_found" };

  if (NON_REJECTABLE_STATUSES.includes(job.status)) {
    return { status: "already_final", job };
  }

  await ArticleJobRepository.mergeMetadata(jobId, {
    rejectedReason: reason,
    rejectedVia: via,
    rejectedAt: new Date().toISOString(),
    // 어느 단계에서 중단했는지 남긴다 - "조사 후 중단"과 "작성 후 중단"은 원인이 다르다
    // (전자는 대개 키워드 자체의 가치 문제, 후자는 원고 품질 문제일 가능성이 높다).
    rejectedAtStatus: job.status,
  });
  const updated = await ArticleJobRepository.updateStatus(jobId, "rejected");

  return { status: "rejected", job: updated ?? job };
}
