// content-blog 스킬이 생성하는 마크다운 원고를 Telegraph Node[] 형식으로 변환한다.
//
// 왜 필요한가: Telegraph API는 HTML 문자열이 아니라 { tag, attrs?, children? } 형태의 Node
// 배열을 요구한다(공식 문서 기준). 우리 원고는 ## 소제목 / **굵게** / - 목록 / [텍스트](URL) /
// 빈 줄 구분 문단만 쓰도록 프롬프트로 강제했으므로(buildArticlePrompt.ts), 이 좁은 마크다운
// 부분집합만 정확히 다루면 된다 - 범용 마크다운 파서를 새로 들여오지 않는다.
//
// Telegraph가 허용하는 태그: a, aside, b, blockquote, br, code, em, figcaption, figure,
// h3, h4, hr, i, iframe, img, li, ol, p, pre, s, strong, u, ul, video. h1/h2는 없다 -
// 우리 원고의 "## 소제목"은 h3로 매핑한다.

export type TelegraphNode = string | { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] };

/** 굵게(**text**)와 링크([text](url))가 섞인 한 줄을 인라인 Node[]로 변환한다. */
function parseInline(text: string): TelegraphNode[] {
  // **굵게**와 [텍스트](URL)를 한 번에 찾는다. 두 패턴이 겹치지 않는다는 전제(우리 프롬프트가
  // 그렇게 쓰도록 강제한다) 하에 순차적으로 스캔한다.
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const nodes: TelegraphNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));

    if (match[1] !== undefined) {
      nodes.push({ tag: "b", children: [match[1]] });
    } else {
      nodes.push({ tag: "a", attrs: { href: match[3] }, children: [match[2]] });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

  return nodes.length > 0 ? nodes : [text];
}

/** 연속된 "- " 목록 줄들을 하나의 ul 블록으로 묶는다. */
function isListLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "");
}

/**
 * 원고 본문(마크다운 부분집합)을 Telegraph Node[]로 변환한다.
 * 빈 줄로 문단을 나누고, 각 문단이 "## "로 시작하면 h3, 전부 "-"로 시작하는 줄이면 ul, 그 외는 p로 만든다.
 */
export function markdownToTelegraphNodes(markdown: string): TelegraphNode[] {
  const paragraphs = markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const nodes: TelegraphNode[] = [];

  for (const block of paragraphs) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // 헤더: 블록 전체가 "## " 한 줄이라고 가정한다(프롬프트가 그렇게 쓰도록 강제한다).
    if (lines.length === 1 && /^##+\s+/.test(lines[0])) {
      const headerText = lines[0].replace(/^##+\s+/, "");
      nodes.push({ tag: "h3", children: parseInline(headerText) });
      continue;
    }

    // 목록: 블록의 모든 줄이 "- "로 시작하면 ul로 묶는다.
    if (lines.every(isListLine)) {
      nodes.push({
        tag: "ul",
        children: lines.map((line) => ({ tag: "li", children: parseInline(stripListMarker(line)) })),
      });
      continue;
    }

    // 일반 문단: 블록 안의 줄바꿈은 <br>로 보존한다(예: FAQ 형식의 질문/답변이 한 블록에 붙어 있는 경우).
    const paragraphChildren: TelegraphNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) paragraphChildren.push({ tag: "br" });
      paragraphChildren.push(...parseInline(line));
    });
    nodes.push({ tag: "p", children: paragraphChildren });
  }

  return nodes;
}
