// ✏️ 수정(job-revise) 결과의 **이미지 마커 diff**와 그에 따른 이미지 보존/갱신 계획(PIPELINE-MERGE-2026-10.md §1-c).
//
// 통합 흐름에서 revise는 이미지가 이미 붙은 원고 이후에 돈다. 이미지는 본문의 `[IMAGE: 설명]` 마커 **순번**으로 원고와
// 짝지어지므로(parseManuscriptBlocks), 마커가 그대로면 이미지도 그대로 유지하고 뷰어만 다시 배포하면 된다.
//
//   · 마커 불변            -> 이미지·게이트 모두 유지. 원고 준비만 다시 돌려 뷰어를 갱신한다(수집·생성 호출 없음).
//   · 같은 개수, 설명 변경  -> 바뀐 자리만 비워 기존 이미지수정 경로(applyImageEditRequest)로 재수집한다.
//   · 개수 변경(추가·삭제)  -> 처음으로 달라진 자리부터 뒤쪽만 갱신한다. 앞쪽 자리는 그대로 둔다.
//
// 왜 개수가 바뀌면 "뒤쪽 전부"인가: 이미지 파일은 Storage에 `<jobId>/<자리번호>.<확장자>`로 올라간다. 번호를 밀어서
// 기존 이미지를 새 번호로 옮기면, 새 자리에 올리는 파일이 밀려 온 다른 이미지를 같은 경로로 덮어쓴다. 전체 재실행은
// 아니면서(앞쪽 보존) 덮어쓰기 사고도 없는 선이 이 규칙이다.

import { applyImageEditRequest } from "../images/applyImageEditRequest.js";
import type { ImageCandidateRecord, ManuscriptImage } from "./manuscriptManifest.js";

const IMAGE_LINE_RE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;

/** 본문에서 `[IMAGE: 설명]` 줄의 설명을 등장 순서대로 뽑는다(`[IMAGE PROMPT:]` 줄은 마커가 아니다). */
export function extractImageMarkers(body: string): string[] {
  const markers: string[] = [];
  for (const line of body.split("\n")) {
    const match = IMAGE_LINE_RE.exec(line.trim());
    if (match) markers.push(match[1].trim());
  }
  return markers;
}

export type MarkerDiff = {
  /** 마커 목록이 완전히 같다(개수·순서·설명). */
  unchanged: boolean;
  /** 새 본문 기준으로 **이미지를 다시 구해야 하는** 자리 번호(1부터). unchanged면 빈 배열. */
  changedIndexes: number[];
  /** 개수가 달라졌다. 이때는 changedIndexes가 처음 다른 자리부터 새 마지막 자리까지다. */
  countChanged: boolean;
  /** 처음으로 달라진 자리(1부터). unchanged면 null. 이 번호 앞의 이미지는 그대로 둔다. */
  firstChanged: number | null;
};

export function diffImageMarkers(before: readonly string[], after: readonly string[]): MarkerDiff {
  const common = Math.min(before.length, after.length);
  let first: number | null = null;
  for (let i = 0; i < common; i += 1) {
    if (before[i] !== after[i]) {
      first = i + 1;
      break;
    }
  }
  const countChanged = before.length !== after.length;
  if (first === null && !countChanged) {
    return { unchanged: true, changedIndexes: [], countChanged: false, firstChanged: null };
  }

  if (!countChanged) {
    // 같은 개수 - 설명이 바뀐 자리만 다시 구한다.
    const changedIndexes: number[] = [];
    for (let i = 0; i < after.length; i += 1) if (before[i] !== after[i]) changedIndexes.push(i + 1);
    return { unchanged: false, changedIndexes, countChanged: false, firstChanged: changedIndexes[0] ?? null };
  }

  // 개수가 달라졌다 - 공통 구간이 전부 같으면 첫 차이는 짧은 쪽 끝 다음 자리다.
  const firstChanged = first ?? common + 1;
  const changedIndexes: number[] = [];
  for (let index = firstChanged; index <= after.length; index += 1) changedIndexes.push(index);
  return { unchanged: false, changedIndexes, countChanged: true, firstChanged };
}

export type ReviseImageMetadata = {
  images: readonly ManuscriptImage[];
  imagePrompts: readonly string[];
  imageCandidates: Record<string, ImageCandidateRecord[]>;
  imageRequirements: Record<string, string> | null;
  imageDirectUrls: Record<string, string> | null;
};

export type ReviseImagePlan =
  | { kind: "keep" }
  | { kind: "refresh"; diff: MarkerDiff; patch: Record<string, unknown>; changedIndexes: number[] };

function omitIndexes<T>(record: Record<string, T> | null, drop: (index: number) => boolean): Record<string, T> | null {
  if (!record) return null;
  const kept = Object.fromEntries(Object.entries(record).filter(([key]) => !drop(Number(key))));
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * 수정 전/후 본문과 현재 이미지 메타데이터로, 이미지를 어떻게 다룰지와 job.metadata 패치를 정한다.
 * 순수 함수 - DB·네트워크 없음. `keep`이면 patch가 없다(호출부는 `channelManuscriptsReadyAt`만 비운다).
 */
export function planReviseImages(
  beforeBody: string,
  afterBody: string,
  current: ReviseImageMetadata
): ReviseImagePlan {
  const before = extractImageMarkers(beforeBody);
  const after = extractImageMarkers(afterBody);
  const diff = diffImageMarkers(before, after);
  if (diff.unchanged) return { kind: "keep" };

  const changed = new Set(diff.changedIndexes);
  const firstChanged = diff.firstChanged ?? 1;
  // 새 마커 설명을 프롬프트 자리에 넣는다 - 마커 수와 프롬프트 수가 같아야 prepare가 짝을 맞춘다.
  const imagePrompts = after.map((description, i) =>
    changed.has(i + 1) || current.imagePrompts[i] === undefined ? description : current.imagePrompts[i]
  );

  let images: readonly ManuscriptImage[];
  let metadataPatch: Record<string, unknown>;
  if (!diff.countChanged) {
    // 같은 개수: 기존 이미지수정 경로 그대로 - 자리를 비우고 재수집 게이트를 연다.
    const applied = applyImageEditRequest(
      current.images,
      diff.changedIndexes.map((index) => ({ index, requirement: "" })),
      {}
    );
    images = applied.patch.images as ManuscriptImage[];
    metadataPatch = { ...applied.patch };
  } else {
    // 개수 변경: 앞쪽은 그대로, 처음 달라진 자리부터는 항목 자체를 버린다(prepare가 빈 자리로 보고 채운다).
    images = current.images.filter((image) => image.index < firstChanged);
    metadataPatch = { images, channelManuscriptsReadyAt: null, webImagesReadyAt: null, imagesReadyAt: null };
  }

  const dropFrom = (index: number): boolean => (diff.countChanged ? index >= firstChanged : changed.has(index));
  return {
    kind: "refresh",
    diff,
    changedIndexes: diff.changedIndexes,
    patch: {
      ...metadataPatch,
      imagePrompts,
      imageCandidates: omitIndexes(current.imageCandidates, dropFrom),
      imageRequirements: omitIndexes(current.imageRequirements, dropFrom),
      imageDirectUrls: omitIndexes(current.imageDirectUrls, dropFrom),
      // 기획·AI 생성·페이지 캡처 게이트: 낡은 자리 번호로 만들어진 캐시라 비운다. 이미 채워진 자리는 prepare가 건너뛴다.
      imagePlan: null,
      imagePlanReadyAt: null,
      planImagesGeneratedAt: null,
      pageCapturesReadyAt: null,
    },
  };
}
