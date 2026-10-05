// manifest -> 트랙별 뷰어 페이지 파일(RESTRUCTURE-PLAN-2026-10.md §3.4). 원고 페이지를 쓰는 세 경로
// (승인 직후 준비 / 수동 빌드 CLI / 뷰어 수정본 반영)가 같은 함수를 쓴다 - 한 곳이 트랙 하나를 빠뜨리면
// 그 트랙 페이지만 옛 상태로 남는다.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { manuscriptPagePath } from "../../config/manuscriptViewerPages.js";
import { DEFAULT_TRACK, TRACKS } from "../../notifications/telegramTracks.js";
import type { Track } from "../../notifications/telegramTracks.js";
import { topicTrack } from "./manuscriptManifest.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";
import { renderManuscriptPage } from "./renderManuscriptPage.js";

/**
 * 엔터 페이지(index.html)는 원고가 없어도 항상 쓴다(기존 동작). 다른 트랙은 원고가 있을 때만 쓴다 -
 * 아직 안 쓰는 트랙의 빈 페이지가 배포에 섞이면 주소만 있고 내용이 없는 화면이 생긴다.
 * 쓴 파일 경로를 돌려준다.
 */
export async function writeManuscriptPages(
  manifest: ManuscriptManifest,
  generatedAt: Date = new Date()
): Promise<string[]> {
  const written: string[] = [];
  for (const track of TRACKS as readonly Track[]) {
    const hasTopics = manifest.topics.some((topic) => topicTrack(topic) === track);
    if (track !== DEFAULT_TRACK && !hasTopics) continue;

    const path = manuscriptPagePath(track);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderManuscriptPage(manifest, generatedAt, { track }), "utf8");
    written.push(path);
  }
  return written;
}
