// articles.content(마크다운 부분집합) -> 독립 HTML 문자열. Blogger API(posts.insert)의 content
// 필드와 티스토리 HTML 모드 붙여넣기에 그대로 쓴다.
//
// convertArticleToNaverHtml.ts와 다른 점: 이미지를 걷어내지 않고 <img src>로 그대로 둔다.
//  - 네이버: SmartEditor toolbar 업로드 경로가 별도로 있어 paste HTML에서는 이미지를 뺐다.
//  - Blogger/티스토리: 외부 URL <img>를 본문 HTML에 그대로 넣는 것이 표준이다(Supabase Storage
//    공개 URL, SPRINT_5_DESIGN.md §2). 티스토리는 이후 실측에서 로컬 업로드로 바꿀 수 있으나
//    지금은 외부 URL로 시작한다.
//
// 마크다운 부분집합은 buildArticlePrompt.ts / generateArticleVariant.ts가 강제하는 형식과 같다:
//   ## 소제목 / **굵게** / *이탤릭* / [텍스트](URL) / - 목록 / ![alt](url) 이미지 / 빈 줄 문단.
// FAQ/요약은 배리에이션 프롬프트가 "## 자주 묻는 질문", "## 요약" 소제목 + 문단으로 만들므로
// 별도 처리 없이 h2/p로 변환된다.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineToHtml(text: string): string {
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) result += escapeHtml(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      result += `<strong>${escapeHtml(match[1])}</strong>`;
    } else if (match[2] !== undefined) {
      result += `<em>${escapeHtml(match[2])}</em>`;
    } else {
      result += `<a href="${escapeHtml(match[4])}" target="_blank" rel="noopener">${escapeHtml(match[3])}</a>`;
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) result += escapeHtml(text.slice(lastIndex));
  return result;
}

const IMAGE_LINE_PATTERN = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

function isListLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "");
}

export type ConvertArticleToHtmlOptions = {
  /** h2/h3 매핑. 기본은 "##"=h2, "###"=h3. 채널 SEO에서 h2 계층이 중요하므로 h2를 기본으로 쓴다. */
  headingBaseLevel?: 2 | 3;
};

/**
 * 원고 본문(마크다운 부분집합)을 독립 HTML 문자열로 변환한다. 이미지는 <figure><img><figcaption>로
 * 렌더링한다(alt를 캡션으로도 노출 - 이미지 SEO §3-1).
 */
export function convertArticleToHtml(markdown: string, options: ConvertArticleToHtmlOptions = {}): string {
  const base = options.headingBaseLevel ?? 2;
  const paragraphs = markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const blocks: string[] = [];

  for (const block of paragraphs) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.length === 1) {
      const imageMatch = lines[0].match(IMAGE_LINE_PATTERN);
      if (imageMatch) {
        const [, alt, src] = imageMatch;
        const caption = alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : "";
        blocks.push(
          `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">${caption}</figure>`
        );
        continue;
      }

      const headingMatch = lines[0].match(/^(#{2,4})\s+(.+)$/);
      if (headingMatch) {
        const level = Math.min(base + (headingMatch[1].length - 2), 4);
        blocks.push(`<h${level}>${inlineToHtml(headingMatch[2])}</h${level}>`);
        continue;
      }
    }

    if (lines.every(isListLine)) {
      const items = lines.map((line) => `<li>${inlineToHtml(stripListMarker(line))}</li>`).join("");
      blocks.push(`<ul>${items}</ul>`);
      continue;
    }

    const paragraphHtml = lines.map((line) => inlineToHtml(line)).join("<br>");
    blocks.push(`<p>${paragraphHtml}</p>`);
  }

  return blocks.join("\n");
}
