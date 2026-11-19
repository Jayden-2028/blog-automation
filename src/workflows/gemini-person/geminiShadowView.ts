// 뷰어(원고 페이지)가 쓰는 제미나이 그림자 쪽 도우미.
//
// 단일 출처 원칙: 제미나이 버전의 원본은 **job.metadata.geminiShadow 하나**다. manifest 행(manuscript_manifest_topics.channels)에는
// 복사해 두지 않는다(saveManifest가 떼어 낸다) - 복사본이 있으면 job 쪽이 갱신될 때 낡은 값이 남는다.
// 페이지를 쓰는 순간(writeManuscriptPages)에 job 쪽을 읽어 덧입힌다 - 페이지는 매 배포마다 DB에서 다시 그려지므로
// 그때그때 최신이 된다.

import { supabase } from "../../services/supabase/client.js";
import type { ManuscriptManifest } from "../manuscripts/manuscriptManifest.js";
import { readGeminiShadow } from "./geminiShadowTypes.js";
import type { GeminiShadow, GeminiShadowSource } from "./geminiShadowTypes.js";

export type GeminiBodyBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "text"; lines: string[] };

/** 뷰어가 그리는 모양. 이미지·편집·발행 필드는 일부러 없다. */
export type GeminiPageView = {
  title: string;
  model: string | null;
  finishedAt: string | null;
  blocks: GeminiBodyBlock[];
  charCount: number;
  sources: GeminiShadowSource[];
  researchNotes: string;
  costUsd: number | null;
  warning: string | null;
  /** 실패한 실행이면 사유(제목·본문이 없을 수 있다). */
  error: string | null;
};

/** 마크다운 본문을 소제목 블록과 문단 블록으로 가른다(뷰어의 기존 블록 렌더와 같은 모양). */
export function parseGeminiBody(body: string): GeminiBodyBlock[] {
  const blocks: GeminiBodyBlock[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length > 0) blocks.push({ type: "text", lines: buffer });
    buffer = [];
  };
  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].replace(/\*\*/g, "").trim() });
    } else if (!line) {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

/** 끝난 실행(성공·실패)만 뷰어에 올린다. 진행 중(finishedAt 없음)이거나 본문도 사유도 없으면 null. */
export function toGeminiPageView(shadow: GeminiShadow | null | undefined): GeminiPageView | null {
  if (!shadow?.finishedAt) return null;
  if (!shadow.body && !shadow.error) return null;
  const body = shadow.body ?? "";
  return {
    title: shadow.title ?? "",
    model: shadow.model ?? null,
    finishedAt: shadow.finishedAt,
    blocks: parseGeminiBody(body),
    charCount: body.replace(/\s/g, "").length,
    sources: shadow.sources ?? [],
    researchNotes: shadow.researchNotes ?? "",
    costUsd: shadow.usage?.totalCostUsd ?? null,
    warning: shadow.warning ?? null,
    error: shadow.error ?? null,
  };
}

export type LoadShadows = (jobIds: string[]) => Promise<Map<string, GeminiShadow>>;

/** job.metadata->geminiShadow 조각만 한 번에 읽는다(metadata 전체를 받지 않는다 - egress). */
export const loadGeminiShadowsFromDb: LoadShadows = async (jobIds) => {
  const out = new Map<string, GeminiShadow>();
  if (jobIds.length === 0) return out;
  const { data, error } = await supabase.from("article_jobs").select("id, geminiShadow:metadata->geminiShadow").in("id", jobIds);
  if (error) throw error;
  for (const row of (data ?? []) as unknown as { id: string; geminiShadow: unknown }[]) {
    const shadow = readGeminiShadow({ geminiShadow: row.geminiShadow });
    if (shadow) out.set(row.id, shadow);
  }
  return out;
};

/**
 * person 원고 행에 job 쪽 geminiShadow를 덧입힌 **새 manifest**를 돌려준다(원본 불변). 읽기에 실패해도
 * 던지지 않는다 - 비교용 부가 정보 때문에 원고 페이지 배포가 막히면 안 된다.
 */
export async function attachGeminiShadows(
  manifest: ManuscriptManifest,
  load: LoadShadows = loadGeminiShadowsFromDb
): Promise<ManuscriptManifest> {
  const personIds = manifest.topics.filter((topic) => topic.category === "person").map((topic) => topic.jobId);
  if (personIds.length === 0) return manifest;
  let shadows: Map<string, GeminiShadow>;
  try {
    shadows = await load(personIds);
  } catch (error) {
    console.warn(`⚠️ [gemini-person] 제미나이 버전을 읽지 못해 페이지에서 뺍니다(원고는 그대로): ${error instanceof Error ? error.message : String(error)}`);
    return manifest;
  }
  return {
    topics: manifest.topics.map((topic) => {
      const shadow = shadows.get(topic.jobId);
      return shadow && toGeminiPageView(shadow)
        ? { ...topic, manuscript: { ...topic.manuscript, geminiShadow: shadow } }
        : topic;
    }),
  };
}
