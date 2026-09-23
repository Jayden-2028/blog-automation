// 이미지 수정 요청을 job.metadata에 반영한다(2026-09-22).
//
// 재수집은 **빈 자리만** 채운다(collectWebImages가 filledIndexes를 받는다). 그래서 "마음에 안
// 드는 자리"를 다시 만들려면 그 자리의 이미지를 먼저 비워야 한다 - 안 비우면 채워진 것으로 보고
// 건너뛴다.
//
// 게이트(channelManuscriptsReadyAt·webImagesReadyAt을 null로)는 resetWebImagesCli와 같은 방식이다.
// 그쪽은 사람이 터미널에서 돌리는 일괄 도구고, 이쪽은 텔레그램 버튼 경로다.

import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import { ACQUISITION_LABEL, inferAcquisition, isLikelyImageUrl } from "./imageEditRequest.js";
import type { ImageEditRequest, RequestedAcquisition } from "./imageEditRequest.js";

/** job.metadata 안의 키. 자리별 요구사항을 다음 수집이 읽는다. */
export const IMAGE_REQUIREMENTS_KEY = "imageRequirements";
/** 사용자가 직접 찍어준 이미지 주소. 있으면 검색하지 않는다. */
export const IMAGE_DIRECT_URLS_KEY = "imageDirectUrls";

export type ApplyImageEditResult = {
  /** metadata에 병합할 패치. 그대로 mergeMetadata에 넘긴다. */
  patch: Record<string, unknown>;
  /** 비운 자리 번호(사용자에게 되읽어 준다). */
  cleared: number[];
  /** 이미 비어 있어 따로 손대지 않은 자리. 어차피 재수집 대상이다. */
  alreadyEmpty: number[];
  /** 링크를 줬지만 이미지 주소가 아니라 쓸 수 없는 자리. 사용자에게 알려야 한다. */
  unusableUrls: number[];
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

  // 사용자가 이미지 주소를 찍어줬으면 검색하지 않고 그것을 쓴다(2026-09-22).
  // 단, 구글 공유 링크처럼 이미지가 아닌 주소는 제외한다 - 내려받으면 HTML이 온다.
  const directUrls: Record<string, string> = {};
  const unusableUrls: number[] = [];
  for (const request of requests) {
    if (!request.url) continue;
    if (isLikelyImageUrl(request.url)) directUrls[String(request.index)] = request.url;
    else unusableUrls.push(request.index);
  }

  return {
    patch: {
      images: nextImages,
      [IMAGE_REQUIREMENTS_KEY]: Object.keys(requirements).length > 0 ? requirements : null,
      [IMAGE_DIRECT_URLS_KEY]: Object.keys(directUrls).length > 0 ? directUrls : null,
      // 게이트 열기 - 다음 job-publish-prepare 실행이 다시 수집한다.
      channelManuscriptsReadyAt: null,
      webImagesReadyAt: null,
      imagesReadyAt: null,
    },
    cleared: cleared.sort((a, b) => a - b),
    alreadyEmpty: alreadyEmpty.sort((a, b) => a - b),
    unusableUrls: unusableUrls.sort((a, b) => a - b),
  };
}

/** 사용자가 찍어준 이미지 주소. 없으면 빈 객체. */
export function readImageDirectUrls(metadata: Record<string, unknown> | null): Record<string, string> {
  const raw = metadata?.[IMAGE_DIRECT_URLS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
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


/** 본문 마커 한 줄. 설명과 획득 방식이 ` — `로 붙어 있다. */
const MARKER_LINE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;

export type MarkerChange = { index: number; from: string; to: RequestedAcquisition };

/**
 * 사용자가 지시한 대로 본문 마커의 **획득 방식을 바꾼다**(2026-09-22).
 *
 * 왜 본문을 고쳐야 하나: 어느 자리를 어떻게 채울지는 전부 마커 끝의 `— 웹 검색` 표기로 갈린다
 * (buildWebImageSlots는 `search`만 보고, 표 렌더러는 `table`만 본다). metadata만 고치면 요청한
 * 방식으로 채우는 코드가 그 자리를 아예 쳐다보지 않는다 - 2026-09-22 실측에서 사용자가 "검색해서
 * 나오는 카톡 캡처"를 요청한 자리가 `AI 생성`이라 검색이 한 번도 안 돌았다.
 *
 * 지시가 애매하면 바꾸지 않는다. 잘못 바꾸면 멀쩡한 자리를 망친다.
 */
export function rewriteAcquisitions(
  body: string,
  requests: readonly ImageEditRequest[]
): { body: string; changes: MarkerChange[] } {
  const wanted = new Map<number, RequestedAcquisition>();
  for (const request of requests) {
    const acquisition = inferAcquisition(request.requirement);
    if (acquisition) wanted.set(request.index, acquisition);
  }
  if (wanted.size === 0) return { body, changes: [] };

  const changes: MarkerChange[] = [];
  let index = 0;
  const lines = body.split("\n").map((line) => {
    const matched = line.trim().match(MARKER_LINE);
    if (!matched) return line;
    index += 1;

    const want = wanted.get(index);
    if (!want) return line;

    const inner = matched[1].trim();
    // 설명과 기존 방식을 가른다. 방식 표기가 없으면 통째로 설명으로 본다.
    const split = inner.lastIndexOf("—");
    const description = (split >= 0 ? inner.slice(0, split) : inner).trim();
    const from = (split >= 0 ? inner.slice(split + 1) : "").trim();
    const to = ACQUISITION_LABEL[want];
    if (from === to) return line; // 이미 그 방식이다

    changes.push({ index, from: from || "(없음)", to: want });
    return `[IMAGE: ${description} — ${to}]`;
  });

  return { body: lines.join("\n"), changes };
}
