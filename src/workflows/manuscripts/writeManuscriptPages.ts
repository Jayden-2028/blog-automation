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
import { attachGeminiShadows } from "../gemini-person/geminiShadowView.js";
import type { LoadShadows } from "../gemini-person/geminiShadowView.js";
import { removeReferencesBlock } from "./articleContentParts.js";

/**
 * 뷰어에는 **"참고 자료" 링크 목록을 보이지 않는다**(2026-11-20 사용자 지시, 전 트랙). 전에는 수동 복붙 트랙(person)만
 * 준비 단계에서 뺐다(manualPasteView.ts). 렌더 직전에 빼므로 **이미 준비된 옛 원고에도** 다음 배포부터 적용된다.
 *
 * 뷰어 화면에서만 뺀다 - DB 원문(articles.content)과 저장된 manifest는 그대로다. 발행 경로는 DB를 읽으므로
 * 영향이 없다(네이버는 원래 빼고, 티스토리는 설계상 남긴다 - publishJobToTistory.ts). 뷰어 수정 반영은 블록 번호가
 * 아니라 원문 텍스트로 DB의 같은 블록을 찾으므로 꼬리 블록이 한쪽에만 있어도 안전하다(manualPasteView.ts 머리말).
 */
export function stripViewerReferences(manifest: ManuscriptManifest): ManuscriptManifest {
  return {
    ...manifest,
    topics: manifest.topics.map((topic) => ({
      ...topic,
      manuscript: {
        ...topic.manuscript,
        body: removeReferencesBlock(topic.manuscript.body),
        ...(topic.manuscript.naver ? { naver: { ...topic.manuscript.naver, body: removeReferencesBlock(topic.manuscript.naver.body) } } : {}),
      },
    })),
  };
}

/**
 * 엔터 페이지(index.html)는 원고가 없어도 항상 쓴다(기존 동작). 다른 트랙은 원고가 있을 때만 쓴다 -
 * 아직 안 쓰는 트랙의 빈 페이지가 배포에 섞이면 주소만 있고 내용이 없는 화면이 생긴다.
 * 쓴 파일 경로를 돌려준다.
 */
export async function writeManuscriptPages(
  manifest: ManuscriptManifest,
  generatedAt: Date = new Date(),
  options: { loadShadows?: LoadShadows } = {}
): Promise<string[]> {
  // 인물 제미나이 그림자 버전은 job.metadata가 원본이라 여기서 덧입힌다(실패해도 원고 페이지는 그대로 나간다).
  manifest = await attachGeminiShadows(manifest, options.loadShadows);
  manifest = stripViewerReferences(manifest);
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
