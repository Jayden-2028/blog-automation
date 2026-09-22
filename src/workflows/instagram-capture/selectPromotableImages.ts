// 인스타 캡처 후보(metadata.instagramImages) -> 뷰어가 쓰는 자리(metadata.images) 승격 규칙.
//
// 규칙이 두 군데(runArticleJob.ts의 자동 승격, promoteInstagramImagesCli.ts의 수동 안전망)에
// 복붙돼 있었고, 그래서 한쪽만 고쳐져 서로 어긋났다(2026-09-22). 순수 함수 하나로 합쳐 두
// 호출부가 같은 판단을 쓰게 한다 - 여기가 유일한 기준이고 testSelectPromotableImages.ts가 고정한다.

import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

export type PromotionDecision = {
  /** 승격할 후보. 한 장도 못 쓰면 null - 호출부는 이때 metadata를 건드리면 안 된다. */
  promote: ManuscriptImage[] | null;
  /** 마커 범위 밖이라 버린 후보 수. */
  dropped: number;
  /** promote가 실제로 채우는 자리 수(서로 다른 index 개수). 같은 슬라이드의 A/B 후보는 한 자리다. */
  filledSlots: number;
};

/**
 * 후보 중 마커 번호 안에 드는 것만 남긴다.
 *
 * **한 장도 안 남으면 `promote: null`이다.** 빈 배열을 그대로 쓰면 호출부가 `images: []`와
 * `imagesReadyAt`을 함께 기록하게 되는데, 그러면 prepareManuscript의 filledIndexes가 비어
 * 웹 이미지 자동 검색이 전 자리를 엉뚱한 사진으로 채운다 - 이 승격이 막으려던 바로 그 증상이다.
 * 승격을 건너뛰면 자리가 빈 채로 뷰어에 떠서 사람이 판단한다(정책: 이미지 최종 판단은 사용자).
 *
 * 같은 index를 가진 후보가 여럿일 수 있다 - 같은 슬라이드의 캡처본과 웹 대체본을 나란히 비교
 * 시키려고 createInstagramJob.ts가 일부러 묶어 둔 것이라 둘 다 남긴다.
 */
export function selectPromotableImages(
  candidates: ManuscriptImage[] | undefined,
  markerCount: number
): PromotionDecision {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { promote: null, dropped: 0, filledSlots: 0 };
  }

  const usable = candidates.filter((c) => c.index <= markerCount);
  const dropped = candidates.length - usable.length;
  const filledSlots = new Set(usable.map((c) => c.index)).size;

  return { promote: usable.length > 0 ? usable : null, dropped, filledSlots };
}

/** job.metadata가 인스타 수동 큐레이션 job인지. 아니면 승격 자체를 하지 않는다. */
export function readInstagramCandidates(
  metadata: Record<string, unknown> | null | undefined
): ManuscriptImage[] | undefined {
  if (!metadata || metadata.source !== "instagram_manual") return undefined;
  const raw = metadata.instagramImages;
  return Array.isArray(raw) ? (raw as ManuscriptImage[]) : undefined;
}
