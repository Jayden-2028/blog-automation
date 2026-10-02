// 발행 서식(변환 결과)의 **단일 구현**. 네이버·Blogspot 변환기와 뷰어 복사가 같은 결과를 내도록
// 블록 렌더링을 여기 한 곳에 둔다(2026-10-02 - 전에는 변환기 두 개가 같은 규칙을 따로 구현했다).
//
// 사용자가 손으로 다듬어 발행한 네이버 글(whyissuenow/224423211962, 224429461072)을 그대로 읽어
// 규칙을 뽑았다. 그 글의 본문은 `se-fs-fs15`, 소제목은 `se-fs-fs19`이고 빈 문단으로 간격을 준다.
//
//   1. 문단이 끝나면 빈 줄 1개
//   2. 소제목은 본문의 125%(본문 15px / 소제목 19px)
//   3. 소제목 바로 아래에는 빈 줄을 넣지 않는다
//   4. 이미지 아래에는 빈 줄 1개
//   5. 마지막 문단과 해시태그 사이에는 빈 줄 2개
//
// 왜 CSS margin이 아니라 **빈 문단**인가: SmartEditor는 붙여넣은 HTML의 margin을 대부분 버린다.
// 사람이 엔터로 만든 것과 같은 빈 문단이라야 네이버·Blogspot 양쪽에서 똑같이 보인다.

/** 본문 15px, 소제목 19px(=본문 × 1.25, 반올림). 사용자가 쓰는 에디터 설정값과 같다. */
export const PUBLISH_FONT_PX = { body: 15, heading: 19 } as const;

/** 사람이 엔터를 친 것과 같은 빈 문단. 네이버·Blogspot 모두 한 줄 간격으로 렌더한다. */
export const SPACER_HTML = "<p>&nbsp;</p>";

export type PublishRenderOptions = {
  /** 굵게에 쓸 태그. 네이버 SmartEditor는 b, Blogspot은 strong을 쓴다(기존 관례 유지). */
  boldTag: "b" | "strong";
  /** 이탤릭 태그. */
  italicTag: "i" | "em";
  /** 이미지 렌더링. Blogspot은 figure+figcaption(이미지 SEO), 네이버는 img 하나. */
  image: "img" | "figure";
  /** 링크에 target/rel을 붙일지(Blogspot만). */
  linkTarget: boolean;
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// URL 안의 괄호는 짝이 맞을 때만 URL의 일부로 본다. 위키백과 `…_(2026년_영화)` 같은 주소가
// `)`에서 끊겨 404 링크가 된 적이 있다(2026-10-03 실측). 짝 없는 `)`는 마크다운 링크의 끝이다.
const URL_SOURCE = String.raw`https?:\/\/(?:[^\s()]|\([^\s()]*\))+`;

/** 굵게(**text**), 이탤릭(*text*), 링크([text](url))가 섞인 한 줄을 인라인 HTML로. */
export function inlineToHtml(text: string, options: PublishRenderOptions): string {
  const pattern = new RegExp(`\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|\\[([^\\]]+)\\]\\((${URL_SOURCE})\\)`, "g");
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) result += escapeHtml(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      result += `<${options.boldTag}>${escapeHtml(match[1])}</${options.boldTag}>`;
    } else if (match[2] !== undefined) {
      result += `<${options.italicTag}>${escapeHtml(match[2])}</${options.italicTag}>`;
    } else {
      const attrs = options.linkTarget ? ' target="_blank" rel="noopener"' : "";
      result += `<a href="${escapeHtml(match[4])}"${attrs}>${escapeHtml(match[3])}</a>`;
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) result += escapeHtml(text.slice(lastIndex));
  return result;
}

const IMAGE_LINE_PATTERN = new RegExp(`^!\\[([^\\]]*)\\]\\((${URL_SOURCE})\\)$`);
const IMAGE_PLACEHOLDER_PATTERN = /^\[IMAGE:[^\]]*\]$/;
const HEADING_LINE_RE = /^\*\*(.+)\*\*$/;

export function isListLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "");
}

/** 본문 끝 "#태그 #태그" 한 줄인지. 그 앞에만 빈 줄 2개가 들어간다(규칙 5). */
export function isHashtagLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^#[^\s#]+$/.test(token));
}

const BODY_STYLE = `font-size:${PUBLISH_FONT_PX.body}px`;
const HEADING_STYLE = `font-size:${PUBLISH_FONT_PX.heading}px`;

function renderLines(lines: string[], options: PublishRenderOptions): string {
  if (lines.every(isListLine)) {
    const items = lines.map((line) => `<li>${inlineToHtml(stripListMarker(line), options)}</li>`).join("");
    return `<ul style="${BODY_STYLE}">${items}</ul>`;
  }
  return `<p style="${BODY_STYLE}">${lines.map((line) => inlineToHtml(line, options)).join("<br>")}</p>`;
}

/**
 * 원고 본문(마크다운 부분집합)을 발행용 HTML로. 블록 사이 간격은 위 5개 규칙대로 **빈 문단**으로 넣는다.
 * 마지막에 남는 빈 문단은 떼어 낸다(글 끝에 빈 줄이 남지 않게).
 */
export function renderPublishBlocks(markdown: string, options: PublishRenderOptions): string {
  const out: string[] = [];
  /** 지금까지 뒤에 붙은 빈 문단 개수. 규칙마다 필요한 개수로 맞춰 쓴다. */
  const trailingSpacers = (): number => {
    let count = 0;
    for (let i = out.length - 1; i >= 0 && out[i] === SPACER_HTML; i -= 1) count += 1;
    return count;
  };
  const setSpacers = (want: number): void => {
    let have = trailingSpacers();
    while (have > want) {
      out.pop();
      have -= 1;
    }
    while (have < want) {
      out.push(SPACER_HTML);
      have += 1;
    }
  };

  for (const block of markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.length === 1) {
      const imageMatch = lines[0].match(IMAGE_LINE_PATTERN);
      if (imageMatch) {
        const [, alt, src] = imageMatch;
        out.push(
          options.image === "figure"
            ? `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">${alt ? `<figcaption style="${BODY_STYLE}">${escapeHtml(alt)}</figcaption>` : ""}</figure>`
            : `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`
        );
        setSpacers(1); // 규칙 4 - 이미지 아래 한 줄
        continue;
      }
      if (IMAGE_PLACEHOLDER_PATTERN.test(lines[0])) {
        out.push(`<p style="${BODY_STYLE}">${escapeHtml(lines[0])}</p>`);
        setSpacers(1);
        continue;
      }
      if (isHashtagLine(lines[0])) {
        setSpacers(2); // 규칙 5 - 마지막 문단과 해시태그 사이 두 줄
        out.push(`<p style="${BODY_STYLE}">${escapeHtml(lines[0])}</p>`);
        continue;
      }
    }

    const headingMatch = lines[0].match(HEADING_LINE_RE);
    if (headingMatch) {
      out.push(`<p style="${HEADING_STYLE}"><${options.boldTag}>${inlineToHtml(headingMatch[1], options)}</${options.boldTag}></p>`);
      const rest = lines.slice(1);
      if (rest.length === 0) continue; // 규칙 3 - 소제목 아래에는 빈 줄을 넣지 않는다
      out.push(renderLines(rest, options));
      setSpacers(1); // 규칙 1 - 문단이 끝나면 한 줄
      continue;
    }

    out.push(renderLines(lines, options));
    setSpacers(1);
  }

  setSpacers(0);
  return out.join("\n");
}
