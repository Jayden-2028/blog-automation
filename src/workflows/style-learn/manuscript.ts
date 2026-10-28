// 파이프라인 원고(articles.content, 마크다운) -> 발행본과 같은 문단 구조로 정규화한다.
import type { PostParagraph } from "./naverPost.js";

const TAIL_HEADING = /^\*{0,2}\s*(함께 보면 좋은 글|관련 글|참고 자료|참고자료)\s*\*{0,2}$/;
const HASHTAG_ONLY = /^(#[^\s#]+\s*)+$/;
const LINK_ONLY = /^[-*]?\s*\[[^\]]*\]\([^)]*\)\s*$/;

/**
 * 원고 마크다운 -> 문단 목록. `[IMAGE: …]` 줄은 버리고, `**소제목**` 단독 줄은 heading,
 * 불릿(`- `)·번호 접두사는 벗기고 문단으로 둔다. 강조 표시(**)는 지운다.
 */
export function manuscriptParagraphs(content: string): PostParagraph[] {
  const out: PostParagraph[] = [];
  for (const raw of content.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    // 본문 뒤에 붙는 꼬리(관련 글·참고 자료·해시태그)는 문체 비교 대상이 아니다. 여기서부터는 끝까지 버린다.
    if (TAIL_HEADING.test(line)) break;
    if (HASHTAG_ONLY.test(line) || LINK_ONLY.test(line)) continue;
    if (/^\[IMAGE:.*\]$/.test(line)) continue;
    if (/^(---+|\*\*\*+)$/.test(line)) continue;
    if (/^#{1,6}\s/.test(line)) {
      out.push({ text: line.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "").trim(), heading: true });
      continue;
    }
    const boldOnly = /^\*\*([^*]+)\*\*$/.exec(line);
    if (boldOnly) {
      out.push({ text: (boldOnly[1] ?? "").trim(), heading: true });
      continue;
    }
    const text = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/\*\*/g, "").trim();
    if (text) out.push({ text, heading: false });
  }
  return out;
}
