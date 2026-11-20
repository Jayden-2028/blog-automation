// 검사를 통과한 납품물 -> 뷰어 manifest 한 행(ManuscriptTopicEntry). 순수 함수 - 업로드는 호출부가 먼저 끝내고 URL을 넘긴다.
//
// 본문 형식을 파이프라인 관례로 바꾸는 이유: 뷰어(parseManuscriptBlocks)는 소제목을 `**볼드**` 한 줄 + 바로 다음 줄의 첫 문단으로
// 읽는다(writer.md §6 관례). Codex는 일반 Markdown(`## `)으로 쓰므로 그대로 두면 소제목이 본문 글자로 보이고, 복사하면
// "## "가 네이버에 그대로 붙는다. 이미지 마커는 블록 하나를 단독으로 차지해야 이미지 자리로 인식된다.
import type { ManuscriptImage, ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import type { ScenepickDelivery } from "./validateScenepickDelivery.js";
import { SCENEPICK_TRACK } from "./scenepickTypes.js";

const MARKER_RE = /^\[IMAGE:[^\]\n]*\]$/;
const HEADING_RE = /^\*\*(.+)\*\*$/;

/** Codex Markdown 본문 -> 파이프라인 본문 관례. H1은 버린다(제목은 meta.title에만 있어야 한다 - AGENTS.md). */
export function normalizeScenepickBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, "");
    if (/^#[ \t]+/.test(line)) continue; // H1 - 제목 중복
    const heading = /^#{2,6}[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (heading) {
      // 소제목 안의 굵게 표시는 벗긴다 - 겉에 **를 다시 두르므로 겹치면 패턴이 깨진다.
      out.push("", `**${heading[1].replace(/\*\*/g, "").trim()}**`, "");
      continue;
    }
    if (MARKER_RE.test(line.trim())) {
      out.push("", line.trim(), "");
      continue;
    }
    out.push(line);
  }

  // 블록 단위로 정리: 소제목 한 줄짜리 블록 뒤에 글 블록이 오면 한 블록으로 붙인다(소제목 + 바로 다음 줄 첫 문단).
  const blocks = out.join("\n").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const merged: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const next = blocks[i + 1];
    if (HEADING_RE.test(block) && next && !MARKER_RE.test(next) && !HEADING_RE.test(next.split("\n")[0])) {
      merged.push(`${block}\n${next}`);
      i += 1;
      continue;
    }
    merged.push(block);
  }
  return merged.join("\n\n");
}

export type UploadedScenepickImage = {
  index: number;
  url: string;
  /** 실제로 올라간 확장자(최적화로 WebP가 될 수 있다). */
  extension: string;
  width?: number | null;
  height?: number | null;
};

/** 이미지 방식 -> provider 표시. 뷰어 대표 이미지 줄과 기록에 보인다. */
export function providerForMethod(method: string | null): string {
  return method === "diagram" ? "codex-diagram" : "codex-ai";
}

export function buildScenepickEntry(input: {
  jobId: string;
  keyword: string;
  delivery: ScenepickDelivery;
  uploads: readonly UploadedScenepickImage[];
  readyAt: string;
  /** KST YYYY-MM-DD. */
  date: string;
  /** 표시용 경로(작업장 기준). */
  filePath: string;
}): ManuscriptTopicEntry {
  const { delivery } = input;
  const uploadByIndex = new Map(input.uploads.map((upload) => [upload.index, upload]));
  const images: ManuscriptImage[] = delivery.images.map((image) => {
    const upload = uploadByIndex.get(image.index);
    return {
      index: image.index,
      // 뷰어는 description을 alt와 그림 아래 캡션으로 쓴다 - 대체 텍스트(alt)가 있으면 그것이 가장 맞다.
      description: image.alt ?? image.description,
      prompt: image.prompt,
      url: upload?.url ?? null,
      provider: providerForMethod(image.method),
      fileName: `${String(image.index).padStart(2, "0")}.${upload?.extension ?? "png"}`,
      ...(upload ? {} : { error: "업로드 실패" }),
      ...(image.caption ? { caption: image.caption } : {}),
      ...(upload?.width && upload?.height ? { width: upload.width, height: upload.height } : {}),
    };
  });

  return {
    jobId: input.jobId,
    keyword: input.keyword,
    // 뷰어 배지·사이드바에 블로그 카테고리가 그대로 보인다(CATEGORY_LABEL에 없으면 원문을 쓴다).
    category: delivery.category,
    date: input.date,
    readyAt: input.readyAt,
    manuscript: {
      title: delivery.title,
      searchDescription: delivery.summary,
      slug: null,
      shortName: input.keyword,
      tags: delivery.tags,
      body: normalizeScenepickBody(delivery.body),
      imagePrompts: [],
      images,
      imageNotes: [],
      filePath: input.filePath,
      naver: null,
      track: SCENEPICK_TRACK,
      // 출처는 본문 밖에 둔다 - 네이버에 붙여넣는 글에는 참고 링크를 넣지 않는다(사용자 사실 확인용).
      sources: delivery.sources.map((source) => ({ title: source.title, url: source.url, publishedAt: source.publishedAt, checkedAt: source.checkedAt })),
    },
  };
}
