// 이미지 수정 요청을 job.metadata에 반영한다(2026-09-22).
//
// 재수집은 **빈 자리만** 채운다(collectWebImages가 filledIndexes를 받는다). 그래서 "마음에 안
// 드는 자리"를 다시 만들려면 그 자리의 이미지를 먼저 비워야 한다 - 안 비우면 채워진 것으로 보고
// 건너뛴다.
//
// 게이트(channelManuscriptsReadyAt·webImagesReadyAt을 null로)는 resetWebImagesCli와 같은 방식이다.
// 그쪽은 사람이 터미널에서 돌리는 일괄 도구고, 이쪽은 텔레그램 버튼 경로다.

import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import type { ImageEditRequest } from "./imageEditRequest.js";

/** job.metadata 안의 키. 자리별 요구사항을 다음 수집이 읽는다. */
export const IMAGE_REQUIREMENTS_KEY = "imageRequirements";

export type ApplyImageEditResult = {
  /** metadata에 병합할 패치. 그대로 mergeMetadata에 넘긴다. */
  patch: Record<string, unknown>;
  /** 비운 자리 번호(사용자에게 되읽어 준다). */
  cleared: number[];
  /** 이미 비어 있어 따로 손대지 않은 자리. 어차피 재수집 대상이다. */
  alreadyEmpty: number[];
};

/**
 * 지정된 자리의 이미지를 비우고, 자리별 요구사항을 남기고, 재수집 게이트를 연다.
 *
 * 지정이 없으면(번호를 안 썼으면) 기존 이미지는 그대로 두고 게이트만 연다 - 빈 자리만 다시
 * 채우는 동작이 된다.
 */
export function applyImageEditRequest(
  images: readonly ManuscriptImage[],
  requests: readonly ImageEditRequest[]
): ApplyImageEditResult {
  const targets = new Set(requests.map((request) => request.index));
  const cleared: number[] = [];
  const alreadyEmpty: number[] = [];

  for (const index of targets) {
    const image = images.find((candidate) => candidate.index === index);
    if (image?.url) cleared.push(index);
    else alreadyEmpty.push(index);
  }

  // 지정된 자리는 url을 지워 "빈 자리"로 만든다. 마커 설명·프롬프트는 남긴다 - 그게 다시 찾을 때
  // 쓰는 단서다.
  const nextImages = images.map((image) =>
    targets.has(image.index) ? { ...image, url: null, sourcePage: null, provider: null } : image
  );

  // 자리별 요구사항. 비어 있는 요구("그냥 다시 찾아라")는 굳이 남기지 않는다.
  const requirements: Record<string, string> = {};
  for (const request of requests) {
    if (request.requirement) requirements[String(request.index)] = request.requirement;
  }

  return {
    patch: {
      images: nextImages,
      [IMAGE_REQUIREMENTS_KEY]: Object.keys(requirements).length > 0 ? requirements : null,
      // 게이트 열기 - 다음 job-publish-prepare 실행이 다시 수집한다.
      channelManuscriptsReadyAt: null,
      webImagesReadyAt: null,
      imagesReadyAt: null,
    },
    cleared: cleared.sort((a, b) => a - b),
    alreadyEmpty: alreadyEmpty.sort((a, b) => a - b),
  };
}

/** 다음 수집이 읽을 자리별 요구사항. 없으면 빈 객체. */
export function readImageRequirements(metadata: Record<string, unknown> | null): Record<string, string> {
  const raw = metadata?.[IMAGE_REQUIREMENTS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}
