// writer.md §9 규격으로 쓰인 drafts/[키워드].md를 파싱한다.
//
// 정본은 articles 테이블이다 - 이 파서는 파일에서 title/본문/해시태그/체크노트를 뽑아 Node가
// articles 행으로 만든다. 본문의 `**소제목**`(볼드, 2026-09-06부터)과 `[IMAGE: 설명]` 마커는
// 그대로 보존한다(다운스트림 변환기가 이 볼드 규격을 쓰고, 이미지 마커는 사용자가 직접 채운다).

export type DraftCheckNote = { label: string; body: string };

export type ParsedDraftFile = {
  keyword: string | null;
  title: string | null;
  skillUsed: string | null;
  verdictFromResearch: string | null;
  /** frontmatter/해시태그 줄/HTML 주석/[IMAGE PROMPT:] 줄을 걷어낸 본문(마크다운, `##`·`[IMAGE:]` 유지). */
  body: string;
  /** 본문 끝 "#태그 #태그" 줄에서 뽑은 태그(# 포함). */
  hashtags: string[];
  /** <!-- 확인 필요 --> / <!-- 사용한 출처 --> 같은 HTML 주석 블록. 검수·감사용으로 metadata에 보관. */
  checkNotes: DraftCheckNote[];
  /**
   * writer가 "[IMAGE PROMPT: ...]"로 남긴 이미지 제작 지시. 발행 본문에는 넣지 않고(장문·중복
   * 유발), 사용자가 이미지를 만들 때 참고하도록 별도 보관한다.
   */
  imagePrompts: string[];
};

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function parseFrontmatter(fm: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const m = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** HTML 주석 블록(<!-- ... -->)을 전부 뽑아내고, 본문에서는 제거한 텍스트를 돌려준다. */
function extractHtmlComments(body: string): { stripped: string; notes: DraftCheckNote[] } {
  const notes: DraftCheckNote[] = [];
  const stripped = body.replace(/<!--([\s\S]*?)-->/g, (_, inner: string) => {
    const trimmed = inner.trim();
    const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
    notes.push({ label: firstLine.trim(), body: trimmed.slice(firstLine.length).trim() });
    return "";
  });
  return { stripped, notes };
}

/**
 * 본문 끝의 "#태그 #태그 ..." 줄을 찾아 태그 배열로 뽑고, 본문에서는 그 줄을 제거한다.
 * writer.md는 해시태그를 본문 마지막(참고 자료 뒤)에 한 줄로 둔다. Node가 결정적으로 다시 붙인다.
 */
function extractHashtags(body: string): { stripped: string; hashtags: string[] } {
  const lines = body.split(/\r?\n/);
  const hashtags: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const isHashtagLine = tokens.length > 0 && tokens.every((t) => /^#[^\s#]+$/.test(t));
    if (isHashtagLine) {
      hashtags.push(...tokens);
    } else {
      kept.push(line);
    }
  }
  return { stripped: kept.join("\n").trim(), hashtags: [...new Set(hashtags)] };
}

/** "[IMAGE PROMPT: ...]" 한 줄 지시를 본문에서 빼내 따로 모은다. "[IMAGE: ...]" 마커는 남긴다. */
function extractImagePrompts(body: string): { stripped: string; imagePrompts: string[] } {
  const imagePrompts: string[] = [];
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.trim().match(/^\[IMAGE\s*PROMPT\s*:\s*([\s\S]*)\]$/i);
    if (m) {
      imagePrompts.push(m[1].trim());
    } else {
      kept.push(line);
    }
  }
  return { stripped: kept.join("\n"), imagePrompts };
}

export function parseDraftFile(text: string): ParsedDraftFile {
  const { frontmatter, body: rawBody } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);

  const { stripped: noComments, notes } = extractHtmlComments(rawBody);
  const { stripped: noPrompts, imagePrompts } = extractImagePrompts(noComments);
  const { stripped: noHashtags, hashtags } = extractHashtags(noPrompts);

  // frontmatter에 title이 있으면 그걸 쓰고, 없으면 본문 첫 "# 제목" 헤더를 폴백으로.
  let title = fm.title || null;
  let body = noHashtags;
  const h1 = body.match(/^#\s+(.+)$/m);
  if (!title && h1) title = h1[1].trim();
  // 본문 맨 앞의 "# 제목" 줄은 제거한다(articles.title로 따로 저장하므로 본문 중복 방지).
  body = body.replace(/^#\s+.+\r?\n+/, "").trim();
  // [IMAGE PROMPT:] 제거로 생긴 빈 줄 3개 이상을 2개로 정리.
  body = body.replace(/\n{3,}/g, "\n\n");

  return {
    keyword: fm.keyword || null,
    title,
    skillUsed: fm.skill_used || null,
    verdictFromResearch: fm.verdict_from_research || null,
    body,
    hashtags,
    checkNotes: notes,
    imagePrompts,
  };
}
