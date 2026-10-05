// 트랙별 원고 뷰어 페이지(RESTRUCTURE-PLAN-2026-10.md §3.4). 같은 Cloudflare Pages 프로젝트에 **경로로
// 분리한 페이지**를 얹는다 - 별도 프로젝트를 파면 Access 게이트를 하나 더 만들어야 하고 그 전까지 공개다.
// 같은 프로젝트의 파일이면 owner-email 게이트를 그대로 상속한다.
import { resolve } from "node:path";

import { DEFAULT_TRACK } from "../notifications/telegramTracks.js";
import type { Track } from "../notifications/telegramTracks.js";
import { MANUSCRIPTS_DIR, PIPELINE_ROOT } from "./pipelinePaths.js";

/** 트랙 -> 배포 디렉터리 안의 파일명. 엔터는 기존 index.html 그대로다(기존 링크·북마크 유지). */
export const VIEWER_PAGE_FILE: Readonly<Record<Track, string>> = {
  entertainment: "index.html",
  social: "social.html",
  kscene: "kscene.html",
};

export function manuscriptPagePath(track: Track = DEFAULT_TRACK): string {
  return resolve(PIPELINE_ROOT, MANUSCRIPTS_DIR, VIEWER_PAGE_FILE[track]);
}

/** 원고 하나로 바로 열리는 링크(#jobId). 엔터는 루트(`/`)를 유지한다. */
export function viewerPageLink(baseUrl: string, track: Track, jobId: string): string {
  return track === DEFAULT_TRACK ? `${baseUrl}/#${jobId}` : `${baseUrl}/${VIEWER_PAGE_FILE[track]}#${jobId}`;
}
