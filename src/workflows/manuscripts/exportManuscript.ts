// 승인된 원고 1건을 맥 로컬 보관함(config/manuscriptExport.ts의 MANUSCRIPT_EXPORT_ROOT)으로 내보낸다.
//
// 내보내는 것: 원고 본문 .md + 생성된 AI 이미지 파일 + image-metadata.md.
// 웹 검색 자리는 파일이 아직 없으므로 "채울 자리"로 메타데이터에 남긴다 - collectWebImages가
// 그 목록을 읽어 Codex에 넘기고, 받아온 이미지를 같은 폴더에 채운다.
//
// 이미지 파일명은 저장소 미러(sync:images)와 같은 `NN-슬러그.확장자`를 쓴다. 번호는 본문
// [IMAGE:] 마커 순서(1부터)라, 폴더만 봐도 몇 번째 자리인지 알 수 있고 웹 검색 자리가 비어 있으면
// 번호가 건너뛴 채로 보인다 - 그 자체가 "여기를 채워야 한다"는 신호다.

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

import { exportTopicDir } from "../../config/manuscriptExport.js";
import { parseManuscriptBlocks } from "./parseManuscriptBlocks.js";
import type { ImageAcquisition } from "./parseManuscriptBlocks.js";
import type { ManuscriptImage, ManuscriptTopicEntry } from "./manuscriptManifest.js";

/**
 * Codex가 찾아 채운 웹 검색 이미지 1장(collectWebImages가 쓴다).
 *
 * manifest(Supabase)에 넣지 않고 주제 폴더의 사이드카 파일로 두는 이유: 이건 파이프라인이 만든
 * 산출물이 아니라 보관함에서 사람이 쓰는 자료다. 여기 두면 내보내기를 다시 돌려도(원고가 갱신돼도)
 * 이미 찾아 둔 이미지와 그 출처가 그대로 살아남고, image-metadata.md도 매번 완전한 상태로 다시 쓰인다.
 */
/** 획득 방식 라벨. 2026-09-18에 `페이지 캡처`가 추가돼 넷이다. */
function acquisitionLabel(acquisition: ImageAcquisition): string {
  if (acquisition === "search") return "웹 검색 이미지";
  if (acquisition === "capture") return "페이지 캡처";
  if (acquisition === "table") return "표·인포그래픽";
  if (acquisition === "ai") return "AI 생성 이미지";
  return "미지정";
}

/** 둘째 줄이 무엇인지 - 방식마다 다르다(검색어 / URL / 생성 프롬프트). */
function promptLabel(acquisition: ImageAcquisition): string {
  if (acquisition === "search") return "검색어";
  if (acquisition === "capture") return "캡처할 URL";
  return "생성 프롬프트";
}

export type WebImageRecord = {
  index: number;
  fileName: string;
  /** 이미지 파일 자체의 URL. */
  imageUrl: string;
  /** 그 이미지가 실린 문서/페이지. 출처 표기는 이쪽을 쓴다. */
  sourcePage: string;
  alt: string;
  caption: string;
  /** "공식 배포" | "보도자료" | "공공저작물" | "언론 보도 화면" 등 - 저작권 판단 근거. */
  license: string;
  /**
   * Supabase Storage 공개 URL. 파이프라인(GitHub Actions)에서 수집하면 러너가 사라지므로 파일을
   * Storage에 올리고 이 URL로 뷰어·manifest가 참조한다. 맥에서 보관함으로만 받으면 없다.
   */
  storageUrl?: string | null;
};

export const WEB_IMAGES_FILE = "web-images.json";

/** 주제 폴더의 사이드카를 읽는다. 없거나 깨졌으면 빈 배열(내보내기는 계속돼야 한다). */
export async function readWebImages(dir: string): Promise<WebImageRecord[]> {
  try {
    const raw = await readFile(resolve(dir, WEB_IMAGES_FILE), "utf-8");
    const parsed = JSON.parse(raw) as { images?: WebImageRecord[] };
    return Array.isArray(parsed.images) ? parsed.images : [];
  } catch {
    return [];
  }
}

/** 본문 마커 1자리. 채워졌으면 file이 있고, 웹 검색 자리는 비어 있다. */
export type ExportedSlot = {
  index: number;
  description: string;
  prompt: string | null;
  acquisition: ImageAcquisition;
  /** 이 자리에 실제로 놓인 파일명들(A/B 비교면 2장). 비어 있으면 아직 채울 자리다. */
  fileNames: string[];
};

export type ExportManuscriptResult = {
  dir: string;
  manuscriptFile: string;
  downloaded: number;
  skipped: number;
  failures: string[];
  slots: ExportedSlot[];
};

export type ExportManuscriptOptions = {
  /** 이미 있는 파일도 다시 받는다. */
  force?: boolean;
  /** 테스트 주입 지점. 기본은 전역 fetch. */
  fetchImage?: (url: string) => Promise<{ ok: boolean; buffer?: Buffer; error?: string }>;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchImage(url: string): Promise<{ ok: boolean; buffer?: Buffer; error?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, buffer: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PNG/JPEG 헤더에서 픽셀 크기를 읽는다. 사용자가 손으로 쓰던 image-metadata.md에 `크기: 960×540`
 * 항목이 있어 형식을 맞춘다. 못 읽는 형식은 null - 메타데이터에서 그 줄만 빠진다.
 */
export function readImageSize(buffer: Buffer): { width: number; height: number } | null {
  // PNG: 8바이트 시그니처 + IHDR 길이/타입(8바이트) 다음에 width/height가 각각 4바이트 빅엔디언.
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: 세그먼트를 훑어 SOF0~SOF15(0xC0~0xCF, 단 0xC4/0xC8/0xCC 제외)에서 높이/너비를 읽는다.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const segmentLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}

/** 본문 마커와 실제로 놓인 이미지(생성 + 웹 검색)를 index로 맞춰 자리 목록을 만든다. */
function buildSlots(
  body: string,
  imagePrompts: string[],
  images: ManuscriptImage[],
  webImages: WebImageRecord[]
): ExportedSlot[] {
  const blocks = parseManuscriptBlocks(body, imagePrompts).filter((b) => b.type === "image");

  return blocks.map((block, i) => {
    const index = i + 1;
    const generated = images.filter((image) => image.index === index && image.url).map((image) => image.fileName);
    const found = webImages.filter((image) => image.index === index).map((image) => image.fileName);
    return {
      index,
      description: block.type === "image" ? block.description : "",
      prompt: block.type === "image" ? block.prompt : null,
      acquisition: block.type === "image" ? block.acquisition : "unknown",
      fileNames: [...generated, ...found],
    };
  });
}

function metadataMarkdown(
  topic: ManuscriptTopicEntry,
  slots: ExportedSlot[],
  sizes: Map<string, string>,
  webImages: WebImageRecord[]
): string {
  const lines: string[] = [`# ${topic.keyword} 이미지 메타데이터`, "", `제작일: ${topic.date}`, ""];

  const images = topic.manuscript.images;

  for (const slot of slots) {
    if (slot.fileNames.length === 0) {
      // 아직 파일이 없는 자리. 웹 검색 자리는 원래 여기 오는 게 정상이고(생성 대상이 아니다),
      // AI 생성 자리가 여기 오면 생성이 실패한 것이다 - 어느 쪽이든 사람이 채워야 할 자리다.
      lines.push(`## ${String(slot.index).padStart(2, "0")} — 채울 자리`, "");
      lines.push(`- 유형: ${acquisitionLabel(slot.acquisition)}`);
      lines.push(`- 설명: ${slot.description}`);
      if (slot.prompt) lines.push(`- ${promptLabel(slot.acquisition)}: ${slot.prompt}`);
      lines.push("");
      continue;
    }

    for (const fileName of slot.fileNames) {
      const web = webImages.find((i) => i.fileName === fileName);
      const image = images.find((i) => i.fileName === fileName);
      lines.push(`## ${fileName}`, "");

      if (web) {
        // 찾아온 이미지는 출처가 메타데이터의 핵심이다 - seo-guide가 무출처 사용을 금지하고,
        // 사용자가 손으로 쓰던 형식에도 출처/원본이 항상 들어 있었다.
        lines.push(`- 유형: 웹 검색 이미지(${web.license})`);
        lines.push(`- ALT: ${web.alt}`);
        lines.push(`- 캡션: ${web.caption}`);
        lines.push(`- 출처: ${web.sourcePage}`);
        lines.push(`- 원본: ${web.imageUrl}`);
      } else {
        lines.push(`- 유형: ${acquisitionLabel(slot.acquisition)}`);
        lines.push(`- ALT: ${slot.description}`);
        lines.push(`- 캡션: ${slot.description}`);
      }

      const size = sizes.get(fileName);
      if (size) lines.push(`- 크기: ${size}`);
      if (image?.provider) lines.push(`- 생성 도구: ${image.provider}`);
      if (image?.prompt) lines.push(`- 생성 프롬프트: ${image.prompt}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function manuscriptMarkdown(topic: ManuscriptTopicEntry): string {
  const m = topic.manuscript;
  const head = [
    `# ${m.title || topic.keyword}`,
    "",
    `- 키워드: ${topic.keyword}`,
    `- 날짜: ${topic.date}`,
    m.slug ? `- 퍼머링크: ${m.slug}` : null,
    m.searchDescription ? `- 검색 설명: ${m.searchDescription}` : null,
    m.tags.length > 0 ? `- 태그: ${m.tags.join(", ")}` : null,
    `- jobId: ${topic.jobId}`,
    "",
    "---",
    "",
  ].filter((line): line is string => line !== null);

  return `${head.join("\n")}${m.body}\n`;
}

export async function exportManuscript(
  topic: ManuscriptTopicEntry,
  options: ExportManuscriptOptions = {}
): Promise<ExportManuscriptResult> {
  const fetchImage = options.fetchImage ?? defaultFetchImage;
  const dir = exportTopicDir(topic.date, topic.keyword, topic.manuscript.shortName);
  await mkdir(dir, { recursive: true });

  const webImages = await readWebImages(dir);
  const slots = buildSlots(topic.manuscript.body, topic.manuscript.imagePrompts, topic.manuscript.images, webImages);
  const failures: string[] = [];
  const sizes = new Map<string, string>();
  let downloaded = 0;
  let skipped = 0;

  for (const image of topic.manuscript.images) {
    if (!image.url) continue;
    const target = resolve(dir, image.fileName);

    if (!options.force && (await exists(target))) {
      skipped += 1;
      continue;
    }

    const result = await fetchImage(image.url);
    if (!result.ok || !result.buffer) {
      failures.push(`[이미지 ${image.index}] 내려받기 실패: ${result.error ?? "알 수 없는 오류"}`);
      continue;
    }

    await writeFile(target, result.buffer);
    const size = readImageSize(result.buffer);
    if (size) sizes.set(image.fileName, `${size.width}×${size.height}`);
    downloaded += 1;
  }

  // 이미 폴더에 있던 파일(건너뛴 생성 이미지, Codex가 채운 웹 검색 이미지)도 크기를 채운다 -
  // 그래야 내보내기를 다시 돌려도 image-metadata.md가 매번 완전한 상태로 쓰인다.
  for (const slot of slots) {
    for (const fileName of slot.fileNames) {
      if (sizes.has(fileName)) continue;
      try {
        const size = readImageSize(await readFile(resolve(dir, fileName)));
        if (size) sizes.set(fileName, `${size.width}×${size.height}`);
      } catch {
        // 파일이 아직 없는 경우(생성 실패 등). 크기 줄만 빠진다.
      }
    }
  }

  const manuscriptFile = resolve(dir, `${topic.manuscript.slug || "manuscript"}.md`);
  await writeFile(manuscriptFile, manuscriptMarkdown(topic));
  await writeFile(resolve(dir, "image-metadata.md"), metadataMarkdown(topic, slots, sizes, webImages));

  return { dir, manuscriptFile, downloaded, skipped, failures, slots };
}
