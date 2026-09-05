// 채널별 원고 열람 페이지(manuscripts/index.html)가 읽는 인덱스. 날짜 -> 주제(job) -> 채널 3개
// 구조를 그대로 담아, renderManuscriptPage가 이 파일 하나만 보고 트리를 그릴 수 있게 한다.
//
// job 1건 = topic 1건(jobId로 upsert). 재실행해도 같은 topic 슬롯을 덮어쓴다(중복 생성 방지).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { manuscriptManifestPath } from "../../config/pipelinePaths.js";
import type { ManuscriptChannel } from "../../config/pipelinePaths.js";

export type ManuscriptChannelEntry = {
  channel: ManuscriptChannel;
  title: string;
  searchDescription: string | null;
  slug: string | null;
  tags: string[];
  body: string;
  /**
   * body에 등장하는 [IMAGE: 설명] 마커와 같은 순서로 짝을 맞추는 이미지 제작 프롬프트
   * (job.metadata.imagePrompts, parseDraftFile.ts가 본문에서 빼내 둔 것). parseManuscriptBlocks가
   * 렌더링 시 이 배열과 본문의 마커 개수를 대조한다 - 개수가 안 맞으면 프롬프트 없이 보여준다.
   */
  imagePrompts: string[];
  /** PIPELINE_ROOT 기준 상대 경로(표시용). 본문 자체는 body에 인라인으로 들어 있다. */
  filePath: string;
};

export type ManuscriptTopicEntry = {
  jobId: string;
  keyword: string;
  category: string | null;
  /** Asia/Seoul 기준 YYYY-MM-DD. */
  date: string;
  readyAt: string;
  channels: ManuscriptChannelEntry[];
};

export type ManuscriptManifest = {
  topics: ManuscriptTopicEntry[];
};

const EMPTY_MANIFEST: ManuscriptManifest = { topics: [] };

export async function loadManifest(path: string = manuscriptManifestPath()): Promise<ManuscriptManifest> {
  if (!existsSync(path)) return { ...EMPTY_MANIFEST };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.topics) ? parsed : { ...EMPTY_MANIFEST };
  } catch {
    return { ...EMPTY_MANIFEST };
  }
}

export async function saveManifest(manifest: ManuscriptManifest, path: string = manuscriptManifestPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

/** 같은 jobId의 기존 topic을 새 entry로 교체한다(없으면 추가). */
export function upsertTopicEntry(manifest: ManuscriptManifest, entry: ManuscriptTopicEntry): ManuscriptManifest {
  return { topics: [...manifest.topics.filter((t) => t.jobId !== entry.jobId), entry] };
}
