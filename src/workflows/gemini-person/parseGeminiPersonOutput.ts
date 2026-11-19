// 집필 호출의 출력(`# 제목` + 마크다운 본문)을 제목/본문으로 가른다. 순수 함수.

export type ParsedGeminiPerson = {
  title: string;
  body: string;
  /** 첫 줄이 `# 제목` 형식이 아니라 첫 줄을 제목으로 쓴 경우 사유. 정상이면 undefined. */
  warning?: string;
};

function stripFence(text: string): string {
  const match = text.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

function plainTitle(line: string): string {
  return line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
}

/** 못 가르면 null(빈 출력). 제목 줄이 없으면 첫 줄을 제목으로 삼고 warning을 단다. */
export function parseGeminiPersonOutput(raw: string): ParsedGeminiPerson | null {
  const lines = stripFence(raw).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return null;

  const first = lines[i].trim();
  const body = (from: number): string => lines.slice(from).join("\n").trim();

  if (/^#\s+\S/.test(first)) {
    const title = plainTitle(first);
    return title ? { title, body: body(i + 1) } : null;
  }
  const title = plainTitle(first);
  if (!title) return null;
  return { title, body: body(i + 1), warning: "첫 줄이 `# 제목` 형식이 아니라 첫 줄을 제목으로 썼다" };
}
