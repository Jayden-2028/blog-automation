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
//   **소제목**(볼드 한 줄, 바로 다음 줄에 문단) / **굵게** / *이탤릭* / [텍스트](URL) / - 목록 /
//   ![alt](url) 이미지 / 문단 사이 빈 줄 1개, 이미지 마커 앞뒤 빈 줄 2개(writer.md §6, 2026-09-06).
// 소제목은 `#` 헤더가 아니라 볼드로 렌더한다 - Blogger 테마 CSS가 h2/h3를 과하게 키우는 경우가
// 있어 <p><strong> 조합이 더 안전하다(붙여넣기 대상 테마에 안 흔들림).
// FAQ/요약도 배리에이션 프롬프트가 "**자주 묻는 질문**", "**요약**" 소제목 + 문단으로 만들므로
// 별도 처리 없이 이 규칙 그대로 변환된다.

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
const IMAGE_PLACEHOLDER_PATTERN = /^\[IMAGE:[^\]]*\]$/;
const HEADING_LINE_RE = /^\*\*(.+)\*\*$/;
/** 이미지(실제/placeholder) 블록 위아래를 다른 블록보다 넓게 띄운다(writer.md §7·§8, 2026-09-06). */
const IMAGE_BLOCK_MARGIN = "margin:2em 0";

function isListLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "");
}

/** 헤더가 아닌 나머지 줄을 목록/문단으로 판정한다(예: "**참고 자료**" 다음 줄이 "- " 목록인 경우). */
function renderNonHeadingLines(lines: string[]): string {
  if (lines.every(isListLine)) {
    const items = lines.map((line) => `<li>${inlineToHtml(stripListMarker(line))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  return `<p>${lines.map((line) => inlineToHtml(line)).join("<br>")}</p>`;
}

/**
 * 원고 본문(마크다운 부분집합)을 독립 HTML 문자열로 변환한다. 이미지는 <figure><img><figcaption>로
 * 렌더링한다(alt를 캡션으로도 노출 - 이미지 SEO §3-1).
 */
export function convertArticleToHtml(markdown: string): string {
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
          `<figure style="${IMAGE_BLOCK_MARGIN}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">${caption}</figure>`
        );
        continue;
      }
      if (IMAGE_PLACEHOLDER_PATTERN.test(lines[0])) {
        blocks.push(`<p style="${IMAGE_BLOCK_MARGIN}">${escapeHtml(lines[0])}</p>`);
        continue;
      }
    }

    // 소제목: 첫 줄이 "**볼드**" 단독이면, 뒤따르는 줄이 문단이면 한 <p> 안에 <br>로 붙여
    // 시각적 간격을 없애고(writer.md §6), 목록이면 별도 요소로 두되 margin을 서로 0으로 맞춘다.
    const headingMatch = lines[0].match(HEADING_LINE_RE);
    if (headingMatch) {
      const rest = lines.slice(1);
      if (rest.length === 0) {
        blocks.push(`<p><strong>${inlineToHtml(headingMatch[1])}</strong></p>`);
      } else if (rest.every(isListLine)) {
        blocks.push(`<p style="margin-bottom:0"><strong>${inlineToHtml(headingMatch[1])}</strong></p>`);
        blocks.push(renderNonHeadingLines(rest).replace("<ul>", '<ul style="margin-top:0">'));
      } else {
        const restHtml = rest.map((line) => inlineToHtml(line)).join("<br>");
        blocks.push(`<p><strong>${inlineToHtml(headingMatch[1])}</strong><br>${restHtml}</p>`);
      }
      continue;
    }

    blocks.push(renderNonHeadingLines(lines));
  }

  return blocks.join("\n");
}
