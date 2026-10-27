// 기존 티스토리 발행 글에 "함께 보면 좋은 글" 내부 링크 블록을 소급해 넣는 순수 함수들(2026-10-28).
// CLI(tistoryBackfillLinksCli.ts)와 테스트(testTistoryRelatedBackfill.ts)가 쓴다 - Playwright·DB를 import하지 않는다.
//
// 왜: 2026-10-28부터 신규 티스토리 글에는 같은 블로그 내부 링크 블록이 들어가지만, 그 전에 발행한 101편은 내부 링크가
// 0개다(실측). 고아 페이지를 줄이려는 2026-09-22 결정(appendRelatedPosts.ts)을 기존 글에도 적용한다.
//
// 원칙:
//   - 관련 글 선정은 appendRelatedPosts의 pickRelatedPosts를 그대로 쓴다(같은 블로그 호스트로 먼저 거름).
//   - 블록 마크업은 신규 발행본과 같게 - 마크다운 블록을 티스토리 변환기에 넣어 만든다(따로 HTML을 짜지 않는다).
//   - 자리는 "참고 자료" 단락 앞 → 해시태그 단락 앞 → 본문 끝(appendRelatedPosts와 같은 순서).
//   - 이미 블록이 있으면 건너뛴다(멱등). 넣는 것은 최상위 블록 추가뿐이고 기존 노드는 건드리지 않는다(editPost 불변 검증).

import { parse, type HTMLElement } from "node-html-parser";

import { convertArticleToTistoryHtml } from "../../services/publish/convertArticleToTistoryHtml.js";
import type { PublishedPost } from "../../services/supabase/repositories/publicationRepository.js";
import { countLinksTo, hrefKey, type EditPlan, type EditorBlock } from "../../services/publish/tistory/tistoryPostEdit.js";
import { pickRelatedPostsForHosts, RELATED_HEADING, relatedBlockMarkdown, type RelatedLink } from "../manuscripts/appendRelatedPosts.js";

/** 블록 제목(마크다운 굵게 표시를 뗀 것). 멱등 판정 기준이다. */
export const RELATED_BLOCK_TITLE = RELATED_HEADING.replace(/\*\*/g, "");
const REFERENCES_TITLE = "참고 자료";
/** 티스토리 변환기가 블록 사이에 넣는 빈 단락. */
export const TISTORY_SPACER_HTML = "<p>&nbsp;</p>";

export type InsertPositionKind = "before-references" | "before-hashtags" | "end";
export type InsertPosition = { kind: InsertPositionKind; /** 이 순번 블록 앞에 넣는다. end면 blocks.length. */ index: number };

export const POSITION_LABEL: Record<InsertPositionKind, string> = {
  "before-references": "참고 자료 앞",
  "before-hashtags": "해시태그 앞",
  end: "본문 끝",
};

/** 같은 블로그 글 중 관련 글(최대 3개). 자기 자신은 job과 주소 둘 다로 뺀다. */
export function selectBackfillLinks(
  target: { jobId: string; keyword: string; category: string | null; url: string },
  candidates: readonly PublishedPost[],
  host: string
): RelatedLink[] {
  const self = hrefKey(target.url, host);
  return pickRelatedPostsForHosts(
    target,
    candidates.filter((post) => hrefKey(post.url, host) !== self),
    [host]
  );
}

/** 신규 발행본과 같은 블록 마크업(`<p …><strong>함께 보면 좋은 글</strong></p><ul …><li><a …>제목</a></li>…</ul>`). */
export function buildRelatedBlockHtml(links: readonly RelatedLink[]): string {
  return convertArticleToTistoryHtml(relatedBlockMarkdown(links)).html.trim();
}

/** 자리에 맞춰 빈 단락을 붙인 삽입 HTML - 앞에 넣을 때는 블록 뒤에, 끝에 붙일 때는 블록 앞에(신규 발행본의 블록 간격과 같게). */
export function buildInsertionHtml(links: readonly RelatedLink[], kind: InsertPositionKind): string {
  const block = buildRelatedBlockHtml(links);
  return kind === "end" ? `${TISTORY_SPACER_HTML}\n${block}` : `${block}\n${TISTORY_SPACER_HTML}`;
}

/** 넣은 블록의 텍스트(공백 무시 비교용). */
export function expectedBlockText(links: readonly RelatedLink[]): string {
  return [RELATED_BLOCK_TITLE, ...links.map((link) => link.title)].join("");
}

function isHashtagLine(text: string): boolean {
  // appendRelatedPosts의 해시태그 줄 판정과 같다.
  return text.startsWith("#") && text.includes(" #");
}

/** 삽입 자리: "참고 자료"(굵은 글씨) 단락 앞 → 해시태그 단락 앞 → 본문 끝. */
export function findRelatedInsertPosition(blocks: readonly EditorBlock[]): InsertPosition {
  const references = blocks.findIndex((block) => block.bold.some((text) => text === REFERENCES_TITLE));
  if (references >= 0) return { kind: "before-references", index: references };
  const hashtags = blocks.findIndex((block) => isHashtagLine(block.text));
  if (hashtags >= 0) return { kind: "before-hashtags", index: hashtags };
  return { kind: "end", index: blocks.length };
}

/** 이미 "함께 보면 좋은 글" 블록이 있나(제목 단락이 그 글자 그대로인 블록). */
export function hasRelatedBlock(blocks: readonly EditorBlock[]): boolean {
  return blocks.some((block) => block.text === RELATED_BLOCK_TITLE || block.bold.includes(RELATED_BLOCK_TITLE));
}

/**
 * editPost에 넘길 계획. 이미 블록이 있으면 아무것도 하지 않는다(noChange → 호출부가 already-has-block으로 적는다).
 * 본문 블록을 못 읽었거나 넣을 링크가 없으면 발행하지 않게 abort.
 */
export function planRelatedInsertion(blocks: readonly EditorBlock[], links: readonly RelatedLink[]): EditPlan & { position?: InsertPosition } {
  if (blocks.length === 0) return { hrefChanges: [], abort: "에디터 본문 블록을 읽지 못했습니다(body.children 0개)." };
  if (hasRelatedBlock(blocks)) return { hrefChanges: [] };
  if (links.length === 0) return { hrefChanges: [], abort: "넣을 관련 글이 없습니다." };
  const position = findRelatedInsertPosition(blocks);
  return {
    hrefChanges: [],
    position,
    insertBlock: {
      html: buildInsertionHtml(links, position.kind),
      beforeIndex: position.kind === "end" ? null : position.index,
      guardText: position.kind === "end" ? null : blocks[position.index].text,
      blockCount: blocks.length,
      expectedText: expectedBlockText(links),
      expectedHrefs: links.map((link) => link.url),
    },
  };
}

function articleContainer(html: string): HTMLElement | null {
  const root = parse(html);
  return root.querySelector(".contents_style") ?? root.querySelector(".tt_article_useless_p_margin");
}

/** 공개 글 페이지에서 본문 최상위 블록(dry-run 자리 예측·멱등 판정·발행 뒤 확인용). 본문 영역을 못 찾으면 null. */
export function blocksFromPublicHtml(html: string): EditorBlock[] | null {
  const container = articleContainer(html);
  return container ? blocksOf(container) : null;
}

function blocksOf(container: HTMLElement): EditorBlock[] {
  return container.childNodes
    .filter((node): node is HTMLElement => node.nodeType === 1)
    .map((el) => ({
      tag: el.rawTagName.toLowerCase(),
      text: el.textContent.replace(/&nbsp;/g, " ").trim(),
      bold: el.querySelectorAll("strong, b").map((b) => b.textContent.trim()),
    }));
}

/** 발행 뒤 공개 페이지 본문에 블록 제목과 넣은 링크가 다 있나. 스킨(관련 글 위젯 등)의 링크와 섞이지 않게 본문 영역만 본다. */
export function verifyRelatedOnPublicPage(html: string, links: readonly RelatedLink[], host: string): { ok: boolean; detail: string } {
  const container = articleContainer(html);
  if (!container) return { ok: false, detail: "본문 영역(.contents_style)을 찾지 못했습니다" };
  const heading = hasRelatedBlock(blocksOf(container));
  const found = links.filter((link) => countLinksTo(container.innerHTML, [link.url], host) > 0).length;
  return { ok: heading && found === links.length, detail: `블록 제목 ${heading ? "있음" : "없음"}, 링크 ${found}/${links.length}` };
}
