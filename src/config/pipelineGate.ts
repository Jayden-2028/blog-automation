// 파이프라인 단계 통합 게이트(PIPELINE-MERGE-2026-10.md §2, 2026-10-08).
//
// 키워드 -> (자료조사) -> **이미지 반영된 원고** -> 단일 승인·수정·발행. 옛 "초안 승인" 단계(원고 완료 알림 +
// ✅/✏️/🗑)를 없애고, write가 끝나면 곧바로 원고 준비(job-publish-prepare)로 잇는다.
//
// `PIPELINE_SKIP_DRAFT_REVIEW`
//   · 기본 true(미설정·빈 값 포함) - 새 흐름.
//   · false/0/off/no - 옛 2단계 흐름으로 복귀. 콜백·알림 코드는 양쪽을 1~2주 공존 지원한다.
//
// 사용설명서(kscene) 트랙은 게이트와 무관하게 옛 흐름이다. 한글 승인 -> 영어본 -> 영어 재승인 2게이트는
// 개편3 지시서가 통합 흐름에 맞춰 재설계한다(PIPELINE-MERGE-2026-10.md §5) - 이 세션은 건드리지 않는다.

import { trackOfJob } from "../notifications/telegramTracks.js";
import type { ArticleJobRow } from "../types/database.js";

export const PIPELINE_SKIP_DRAFT_REVIEW_ENV = "PIPELINE_SKIP_DRAFT_REVIEW";

const OFF_VALUES = new Set(["false", "0", "off", "no"]);

/** 환경변수 값 해석. undefined/빈 문자열은 기본값(켜짐)이다 - 워크플로가 `vars.X`를 빈 값으로 넘기는 경우를 막는다. */
export function parseSkipDraftReview(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return !OFF_VALUES.has(normalized);
}

/** 이 job이 초안 승인 단계를 건너뛰는가. 게이트가 꺼져 있거나 사용설명서 트랙이면 false(옛 흐름). */
export function shouldSkipDraftReview(
  job: Pick<ArticleJobRow, "metadata">,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!parseSkipDraftReview(env[PIPELINE_SKIP_DRAFT_REVIEW_ENV])) return false;
  return trackOfJob(job) !== "kscene";
}

/**
 * 자동 승인으로 올라온 job인가(`metadata.autoApprovedAt`). 통합 알림의 ✏️/🗑 버튼·검수 요약은 환경변수가 아니라
 * 이 기록을 본다 - 게이트를 중간에 바꿔도 job마다 자기가 지나온 흐름의 알림을 받는다.
 */
export function isAutoApproved(job: Pick<ArticleJobRow, "metadata">): boolean {
  const value = (job.metadata as Record<string, unknown> | null | undefined)?.autoApprovedAt;
  return typeof value === "string" && value.length > 0;
}
