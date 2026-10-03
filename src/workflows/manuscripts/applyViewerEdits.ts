// 뷰어에서 고친 본문·캡션을 **발행 원고**에 옮겨 적는 계산부(2026-10-03 사용자 요청). DB 접근 없음.
//
// 왜 필요한가: 뷰어 수정은 브라우저 localStorage에만 남는데, 발행 버튼(Blogspot·네이버)은 DB의
// `articles.content`(본문)와 `job.metadata.images[].description`(캡션)을 읽는다. 그래서 뷰어에서
// 고치고 발행 버튼을 누르면 **옛 글이 올라갔다.** 이 모듈이 그 둘을 뷰어 수정본으로 바꾼 값을 계산한다.
//
// 뷰어가 보는 본문(manifest body)과 발행 본문(articles.content)은 **글자 단위로 같지 않다**:
//   - manifest에는 끝 해시태그 줄이 빠져 있다(splitTrailingHashtags - 뷰어는 tags로 따로 그린다).
//   - 2026-10-04 전에 준비된 원고는 "함께 보면 좋은 글"(내부 링크)이 manifest에만 있다. 그 뒤로는 준비
//     단계가 DB 원고에도 저장하므로 양쪽에 같이 있다(prepareManuscript의 withRelatedPosts).
//   - `표 생성` 자리는 manifest에서만 빠졌을 수 있다(removeTableMarkers).
// 그래서 뷰어의 블록 **번호**로 발행 본문을 고치면 엉뚱한 문단을 덮는다. 대신 그 블록의 **원문 텍스트**로
// 발행 본문에서 같은 블록을 찾는다(같은 텍스트가 여러 번이면 몇 번째인지까지 맞춘다). 못 찾으면 그
// 항목은 건너뛰고 사유를 남긴다 - 엉뚱한 문단을 고치는 것보다 안전하다.
//
// 뷰어는 고친 값(to)과 함께 **고치기 전 값(from)**을 보낸다. 페이지를 연 뒤 원고가 다시 준비됐으면
// (이미지 수정 등) 번호가 밀려 있을 수 있다 - from이 지금 원고와 다르면 그 항목도 건너뛴다.
//
// 이미지 마커(`[IMAGE: ...]`)는 고칠 수 없다. 이미지는 마커 등장 순서로 짝지어지므로(index) 마커를
// 넣거나 빼면 뒤 자리 이미지가 전부 한 칸씩 밀린다.

import { matchImageBlock, parseManuscriptBlocks, stripAcquisitionSuffix } from "./parseManuscriptBlocks.js";
import type { ManuscriptBlock } from "./parseManuscriptBlocks.js";
import type { ManuscriptImage } from "./manuscriptManifest.js";

export type ViewerEdit = { from: string; to: string };
/** 키: `"3"`(본문 블록 3), `"3:h"`/`"3:b"`(소제목 블록 3의 제목/본문), `"cap:2"`(이미지 자리 2의 캡션). */
export type ViewerEdits = Record<string, ViewerEdit>;

export const VIEWER_EDIT_KEY_RE = /^(?:\d{1,4}(?::[hb])?|cap:\d{1,3})$/;

export type ApplyViewerEditsInput = {
  /** manifest에 저장된 본문 - 뷰어가 블록 번호를 매긴 바로 그 본문. */
  manifestBody: string;
  imagePrompts: string[];
  /** 발행 버튼이 읽는 최종 원고(pickFinalArticle(...).final.content). */
  articleContent: string;
  /** job.metadata.images. manifest의 images도 같은 값이다. */
  images: ManuscriptImage[];
  edits: ViewerEdits;
};

export type ApplyViewerEditsResult = {
  manifestBody: string;
  articleContent: string;
  images: ManuscriptImage[];
  /** 반영한 키. */
  applied: string[];
  /** 건너뛴 키와 사유. */
  skipped: { key: string; reason: string }[];
  articleChanged: boolean;
  imagesChanged: boolean;
};

/** 비교용 정규화 - 브라우저 innerText가 넣는 nbsp·CRLF·앞뒤 공백 차이를 무시한다. */
export function normalizeEditText(value: string): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

type Segment = { text: string; sep: string };

/** `\n{2,}`로 나누되 구분자를 보존한다 - 고치지 않은 부분은 바이트 그대로 돌려놓기 위해서다. */
function splitSegments(body: string): Segment[] {
  const parts = body.split(/(\n{2,})/);
  const segments: Segment[] = [];
  for (let i = 0; i < parts.length; i += 2) segments.push({ text: parts[i], sep: parts[i + 1] ?? "" });
  return segments;
}

/** parseManuscriptBlocks와 같은 기준으로 "블록"인 구간(trim 후 비어 있지 않은 것)의 위치. */
function blockPositions(segments: Segment[]): number[] {
  const positions: number[] = [];
  segments.forEach((segment, i) => {
    if (segment.text.trim()) positions.push(i);
  });
  return positions;
}

function joinSegments(segments: Segment[]): string {
  return segments
    .map((segment) => segment.text + segment.sep)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 고친 블록을 원고 표기로 되돌린다(parseManuscriptBlocks의 역). */
function blockToRaw(block: ManuscriptBlock, edit: { heading?: string; body?: string; content?: string }): string {
  if (block.type === "heading") {
    const heading = normalizeEditText(edit.heading ?? block.heading);
    const body = normalizeEditText(edit.body ?? block.body);
    if (!heading) return body;
    return body ? `**${heading}**\n${body}` : `**${heading}**`;
  }
  if (block.type === "text") return normalizeEditText(edit.content ?? block.content);
  return "";
}

/** 새 텍스트에 이미지 마커가 섞였는가. 마커를 넣거나 빼면 이미지 번호가 밀린다. */
function containsImageMarker(raw: string): boolean {
  return raw.split(/\n{2,}/).some((part) => matchImageBlock(part.trim()) !== null) || /^\s*\[IMAGE(?: PROMPT)?:/m.test(raw);
}

/** 뷰어가 보여주는 그 자리의 캡션(수정 전). renderManuscriptPage의 captionFor와 같은 규칙. */
export function currentCaption(images: ManuscriptImage[], index: number, markerDescription: string): string {
  const shots = images.filter((image) => image.index === index);
  return (shots[0] && shots[0].description) || stripAcquisitionSuffix(markerDescription) || "캡션 없음";
}

export function applyViewerEdits(input: ApplyViewerEditsInput): ApplyViewerEditsResult {
  const applied: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  const blocks = parseManuscriptBlocks(input.manifestBody, input.imagePrompts);
  const manifestSegments = splitSegments(input.manifestBody);
  const manifestPositions = blockPositions(manifestSegments);
  const articleSegments = splitSegments(input.articleContent);
  const articlePositions = blockPositions(articleSegments);

  // 이미지 자리 번호(1부터) -> 블록 번호.
  const imageBlockIndexes: number[] = [];
  blocks.forEach((block, i) => {
    if (block.type === "image") imageBlockIndexes.push(i);
  });

  // ---- 1) 키를 블록 단위로 묶는다(소제목 블록은 :h와 :b가 함께 한 블록을 바꾼다) ----
  const byBlock = new Map<number, { keys: string[]; heading?: string; body?: string; content?: string }>();
  const captionEdits: { key: string; index: number; to: string }[] = [];

  for (const [key, edit] of Object.entries(input.edits)) {
    if (!VIEWER_EDIT_KEY_RE.test(key) || !edit || typeof edit.from !== "string" || typeof edit.to !== "string") {
      skipped.push({ key, reason: "알 수 없는 수정 형식" });
      continue;
    }
    const from = normalizeEditText(edit.from);
    const to = normalizeEditText(edit.to);
    if (from === to) continue; // 바뀐 게 없다 - 조용히 넘긴다.

    if (key.startsWith("cap:")) {
      const n = Number(key.slice(4));
      const blockIndex = imageBlockIndexes[n - 1];
      if (blockIndex === undefined) {
        skipped.push({ key, reason: `이미지 자리 ${n}번이 지금 원고에 없습니다` });
        continue;
      }
      const block = blocks[blockIndex] as Extract<ManuscriptBlock, { type: "image" }>;
      if (normalizeEditText(currentCaption(input.images, n, block.description)) !== from) {
        skipped.push({ key, reason: "페이지를 연 뒤 캡션이 바뀌었습니다 - 새로고침 후 다시 고치세요" });
        continue;
      }
      if (!input.images.some((image) => image.index === n && image.url)) {
        skipped.push({ key, reason: `이미지 자리 ${n}번이 비어 있어 발행본에 실릴 캡션이 없습니다` });
        continue;
      }
      if (!to) {
        skipped.push({ key, reason: "캡션을 비울 수는 없습니다" });
        continue;
      }
      captionEdits.push({ key, index: n, to });
      continue;
    }

    const [indexText, field] = key.split(":");
    const index = Number(indexText);
    const block = blocks[index];
    if (!block || block.type === "image") {
      skipped.push({ key, reason: "페이지를 연 뒤 원고가 바뀌었습니다 - 새로고침 후 다시 고치세요" });
      continue;
    }
    const original =
      block.type === "heading" ? (field === "h" ? block.heading : field === "b" ? block.body : null) : field ? null : block.content;
    if (original === null || normalizeEditText(original) !== from) {
      skipped.push({ key, reason: "페이지를 연 뒤 원고가 바뀌었습니다 - 새로고침 후 다시 고치세요" });
      continue;
    }
    const slot = byBlock.get(index) ?? { keys: [] };
    slot.keys.push(key);
    if (field === "h") slot.heading = to;
    else if (field === "b") slot.body = to;
    else slot.content = to;
    byBlock.set(index, slot);
  }

  // ---- 2) 본문 블록을 manifest와 발행 원고 양쪽에서 바꾼다 ----
  // 원문을 먼저 떠 둔다 - 앞 블록을 바꾼 뒤에 "같은 문단이 몇 번째인가"를 세면 바뀐 글자를 읽게 된다.
  const manifestOriginals = manifestPositions.map((pos) => manifestSegments[pos].text.trim());
  const articleOriginals = articleSegments.map((segment) => segment.text.trim());
  for (const [index, slot] of byBlock) {
    const block = blocks[index];
    const newRaw = blockToRaw(block, slot);
    if (containsImageMarker(newRaw)) {
      for (const key of slot.keys) skipped.push({ key, reason: "이미지 마커는 뷰어에서 넣거나 뺄 수 없습니다" });
      continue;
    }

    const manifestPos = manifestPositions[index];
    const originalRaw = manifestOriginals[index];

    // 발행 원고에서 같은 블록 찾기 - 같은 텍스트가 앞에 몇 번 나왔는지(k)까지 맞춘다.
    let occurrence = 0;
    for (let i = 0; i < index; i += 1) {
      if (manifestOriginals[i] === originalRaw) occurrence += 1;
    }
    const matches = articlePositions.filter((pos) => articleOriginals[pos] === originalRaw);
    const articlePos = matches[occurrence];
    if (articlePos === undefined) {
      for (const key of slot.keys) {
        skipped.push({ key, reason: "발행 원고에서 같은 문단을 찾지 못했습니다(10월 4일 전에 준비된 원고의 내부 링크처럼 뷰어에만 있는 부분)" });
      }
      continue;
    }

    manifestSegments[manifestPos] = { ...manifestSegments[manifestPos], text: newRaw };
    articleSegments[articlePos] = { ...articleSegments[articlePos], text: newRaw };
    applied.push(...slot.keys);
  }

  // ---- 3) 캡션 ----
  let images = input.images;
  if (captionEdits.length > 0) {
    images = input.images.map((image) => {
      const edit = captionEdits.find((c) => c.index === image.index);
      return edit ? { ...image, description: edit.to } : image;
    });
    applied.push(...captionEdits.map((c) => c.key));
  }

  const articleContent = byBlock.size > 0 ? joinSegments(articleSegments) : input.articleContent;
  const manifestBody = byBlock.size > 0 ? joinSegments(manifestSegments) : input.manifestBody;

  return {
    manifestBody,
    articleContent,
    images,
    applied,
    skipped,
    articleChanged: articleContent !== input.articleContent,
    imagesChanged: captionEdits.length > 0,
  };
}
