// Codex 납품물 형식 검사(2026-11-21). **형식만** 본다 - 문체·분량 목표(AGENTS.md: 이미지 4~8장, 2,500~6,000자)는 Codex 몫이고,
// 여기 하한(이미지 1장·본문 1,200자)은 "깨진 납품"을 잡는 바닥이지 품질 기준이 아니다(리드 지시). 내용 판단은 사람이 뷰어에서 한다.
//
// 납품 규격(codex/scenepick/AGENTS.md "납품 규격"과 같아야 한다):
//   jobs/<jobId>/manuscript.md  본문 Markdown(H1 없음, `## ` 소제목, 이미지 자리는 한 줄 전체 `[IMAGE: 설명]`)
//   jobs/<jobId>/meta.json      { title, category(다섯 중 하나), tags[], summary, images[{index,file,description,alt?,caption?,method?,prompt?}], sources[{title,url,publishedAt?,checkedAt?}] }
//   jobs/<jobId>/images/*       meta.images[].file이 가리키는 PNG/JPEG/WEBP
//
// **모르는 필드·여분 파일로는 실패하지 않는다**(리드 지시 2026-11-21): 납품 폴더에는 sources.json·review.md·offline.html·
// delivery.json·images/src/*.svg 같은 부산물이 함께 올 수 있다. 이미지 파일은 meta.images가 가리키는 것만 센다.
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";

import { sniffImageFormat } from "../../services/images/sniffImageFormat.js";
import { isScenepickCategory, SCENEPICK_CATEGORIES } from "./scenepickTypes.js";
import type { ScenepickCategory } from "./scenepickTypes.js";

export const MIN_BODY_CHARS = 1200;
export const MIN_IMAGE_BYTES = 10 * 1024;
export const MIN_IMAGES = 1;
const MAX_TAGS = 10;
const MAX_SUMMARY_CHARS = 160;
const ALLOWED_FORMATS = new Set(["png", "jpg", "webp"]);
const MIME_BY_SNIFF: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export type ScenepickDeliveryImage = {
  index: number;
  /** 납품 폴더 기준 상대 경로(meta 값 그대로). */
  file: string;
  /** 절대 경로. */
  path: string;
  mimeType: string;
  bytes: number;
  description: string;
  alt: string | null;
  caption: string | null;
  method: string | null;
  prompt: string | null;
};

export type ScenepickSource = { title: string; url: string; publishedAt: string | null; checkedAt: string | null };

export type ScenepickDelivery = {
  body: string;
  title: string;
  category: ScenepickCategory;
  tags: string[];
  summary: string | null;
  images: ScenepickDeliveryImage[];
  sources: ScenepickSource[];
};

export type ScenepickValidation = { ok: true; delivery: ScenepickDelivery } | { ok: false; failures: string[] };

const MARKER_LINE_RE = /^[ \t]*\[IMAGE:[^\]\n]*\][ \t]*$/gm;

/** 이미지 마커 줄을 뺀 본문의 공백 제외 글자 수. 분량 하한은 글자에 대해서만 잰다. */
export function bodyCharCount(body: string): number {
  return body.replace(MARKER_LINE_RE, "").replace(/\s/g, "").length;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 납품 폴더 밖을 가리키는 경로(절대 경로·`..`)는 받지 않는다 - Codex가 엉뚱한 파일을 올리게 만들 수 없다. */
function insideDir(file: string): boolean {
  if (isAbsolute(file)) return false;
  const norm = normalize(file);
  return !norm.startsWith("..") && !norm.split(sep).includes("..");
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.replace(/^#+/, "").trim();
    if (tag && !seen.has(tag)) seen.add(tag);
  }
  return [...seen].slice(0, MAX_TAGS);
}

export function normalizeSources(raw: unknown): ScenepickSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ScenepickSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = str(record.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: str(record.title) ?? "", url, publishedAt: str(record.publishedAt), checkedAt: str(record.checkedAt) });
  }
  return out;
}

/**
 * 납품 폴더 하나를 검사한다. 실패 항목은 **그대로 재작업 주문에 실을 수 있는 문장**으로 돌려준다(Codex가 읽는다).
 * 파일 시스템만 읽는다 - DB·네트워크 없음.
 */
export async function validateScenepickDelivery(dir: string): Promise<ScenepickValidation> {
  const failures: string[] = [];

  let body = "";
  try {
    body = (await readFile(join(dir, "manuscript.md"), "utf8")).replace(/\r\n?/g, "\n");
  } catch {
    failures.push("manuscript.md가 없습니다(납품 폴더에 본문 Markdown을 저장).");
  }

  let meta: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    else failures.push("meta.json이 JSON 객체가 아닙니다.");
  } catch (error) {
    failures.push(
      error && typeof error === "object" && (error as { code?: string }).code === "ENOENT"
        ? "meta.json이 없습니다."
        : `meta.json을 JSON으로 읽을 수 없습니다(${error instanceof Error ? error.message.slice(0, 120) : "parse error"}).`
    );
  }

  const title = str(meta?.title);
  if (meta && !title) failures.push("meta.json의 title이 비어 있습니다.");
  const category = meta?.category;
  if (meta && !isScenepickCategory(category)) {
    failures.push(`meta.json의 category가 다섯 중 하나가 아닙니다(받은 값: ${JSON.stringify(category ?? null)}). 허용: ${SCENEPICK_CATEGORIES.join(" | ")}`);
  }

  if (body) {
    const chars = bodyCharCount(body);
    if (chars < MIN_BODY_CHARS) failures.push(`본문이 너무 짧습니다(이미지 마커 제외 공백 빼고 ${chars}자, 최소 ${MIN_BODY_CHARS}자).`);
  }
  const markerTotal = (body.match(/\[IMAGE:/g) ?? []).length;
  const markerLines = (body.match(MARKER_LINE_RE) ?? []).length;
  if (markerTotal !== markerLines) {
    failures.push(`[IMAGE: 설명] 마커는 한 줄 전체여야 합니다(문장 안에 섞인 마커 ${markerTotal - markerLines}개).`);
  }

  const rawImages = meta ? meta.images : undefined;
  const images: ScenepickDeliveryImage[] = [];
  if (meta && !Array.isArray(rawImages)) {
    failures.push("meta.json의 images가 배열이 아닙니다.");
  } else if (Array.isArray(rawImages)) {
    if (rawImages.length < MIN_IMAGES) failures.push(`이미지가 없습니다(최소 ${MIN_IMAGES}장).`);
    if (body && markerTotal !== rawImages.length) {
      failures.push(`본문 [IMAGE: 마커 수(${markerTotal})와 meta.json images 수(${rawImages.length})가 다릅니다.`);
    }
    const indices = rawImages.map((item) => Number((item as Record<string, unknown> | null)?.index));
    const sorted = [...indices].sort((a, b) => a - b);
    const contiguous = sorted.every((value, i) => value === i + 1);
    if (!contiguous) failures.push(`images[].index가 1부터 빠짐없이 이어지지 않습니다(받은 값: ${indices.join(", ")}).`);

    for (const item of rawImages) {
      const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const index = Number(record.index);
      const label = `이미지 ${Number.isFinite(index) ? index : "?"}`;
      const file = str(record.file);
      if (!file) {
        failures.push(`${label}: file이 비어 있습니다.`);
        continue;
      }
      if (!insideDir(file)) {
        failures.push(`${label}: file(${file})은 납품 폴더 안의 상대 경로여야 합니다.`);
        continue;
      }
      const path = join(dir, file);
      const size = await fileSize(path);
      if (size === null) {
        failures.push(`${label}: 파일 ${file}이 없습니다.`);
        continue;
      }
      if (size <= MIN_IMAGE_BYTES) {
        failures.push(`${label}: 파일 ${file}이 너무 작습니다(${size}바이트 - 10KB 초과여야 함, 깨진 이미지로 봅니다).`);
        continue;
      }
      const format = sniffImageFormat(await readFile(path));
      if (!format || !ALLOWED_FORMATS.has(format)) {
        failures.push(`${label}: 파일 ${file}이 PNG/JPEG/WEBP가 아닙니다(감지: ${format ?? "알 수 없음"}).`);
        continue;
      }
      images.push({
        index,
        file,
        path,
        mimeType: MIME_BY_SNIFF[format],
        bytes: size,
        description: str(record.description) ?? "",
        alt: str(record.alt),
        caption: str(record.caption),
        method: str(record.method),
        prompt: str(record.prompt),
      });
    }
  }

  if (failures.length > 0 || !meta || !title || !isScenepickCategory(category)) {
    return { ok: false, failures: failures.length > 0 ? failures : ["납품물을 읽지 못했습니다."] };
  }
  const summary = str(meta.summary);
  return {
    ok: true,
    delivery: {
      body,
      title,
      category,
      tags: normalizeTags(meta.tags),
      summary: summary ? summary.slice(0, MAX_SUMMARY_CHARS) : null,
      images: images.sort((a, b) => a.index - b.index),
      sources: normalizeSources(meta.sources),
    },
  };
}
