// `— 표 생성` 이미지 자리가 무엇을 그릴지 **본문에서** 뽑아낸다.
//
// 왜 LLM에 다시 묻지 않는가(2026-09-18 사용자 결정): 그 데이터는 이미 원고에 있고 검수를 통과한
// 값이다. 다시 물으면 숫자를 잘못 옮길 위험과 호출 비용만 생긴다. 바로 위 블록의 표·목록을
// 그대로 읽어 쓴다 - §8-1의 "바로 위 문단을 한 장으로 요약"과 같은 원칙이다.
//
// 원고는 마크다운 표(`|`)보다 **글머리 목록**을 많이 쓴다(output-format.md §7이 붙여넣기 편의를 위해
// 목록을 권한다). 그래서 둘 다 받는다.

export type TableRow = { label: string; value: string };

export type TableData = {
  /** 이미지 상단 제목. 바로 앞 소제목이 있으면 그것, 없으면 마커 설명에서 만든다. */
  title: string;
  rows: TableRow[];
};

/** `**볼드**` 소제목 한 줄을 떼어낸다(writer.md §6 규격). */
function stripHeading(block: string): { heading: string | null; rest: string } {
  const lines = block.split("\n");
  const matched = lines[0].match(/^\*\*(.+)\*\*$/);
  return matched ? { heading: matched[1].trim(), rest: lines.slice(1).join("\n") } : { heading: null, rest: block };
}

/** 마크다운 표(`| a | b |`)를 label/value로 읽는다. 열이 3개 이상이면 첫 열을 label, 나머지를 합친다. */
function parseMarkdownTable(text: string): TableRow[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (lines.length < 2) return [];

  const cells = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

  // 구분선(|---|---|)은 건너뛴다.
  const rows = lines.filter((line) => !/^\|[\s:|-]+\|$/.test(line)).map(cells);
  if (rows.length === 0) return [];

  return rows
    .map((row) => ({ label: row[0] ?? "", value: row.slice(1).filter(Boolean).join(" · ") }))
    .filter((row) => row.label);
}

/**
 * 글머리 목록을 읽는다. `- 10월 7일: 출생연도 끝자리가 홀수인 청년`처럼 콜론이 있으면 앞뒤를
 * label/value로 가르고, 없으면 전체를 label로 둔다(값 없는 나열도 카드로 그릴 수 있다).
 */
function parseList(text: string): TableRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, ""))
    .map((item) => {
      // 콜론이 여러 개면 첫 번째에서만 자른다("10월 12일~16일: 누구나" 같은 값 보존).
      const at = item.indexOf(":");
      if (at <= 0) return { label: item.replace(/\*\*/g, "").trim(), value: "" };
      return {
        label: item.slice(0, at).replace(/\*\*/g, "").trim(),
        value: item.slice(at + 1).replace(/\*\*/g, "").trim(),
      };
    })
    .filter((row) => row.label);
}

/**
 * 이미지 자리 바로 앞 블록들에서 표·목록을 찾는다. 가장 가까운 것부터 보되, 바로 앞이 설명 문단이면
 * 한 칸 더 거슬러 올라간다(설명 → 목록 → 마커 순서가 흔하다).
 */
export function extractTableData(precedingBlocks: string[], fallbackTitle: string): TableData | null {
  for (let i = precedingBlocks.length - 1; i >= 0 && i >= precedingBlocks.length - 3; i--) {
    const { heading, rest } = stripHeading(precedingBlocks[i]);
    const rows = parseMarkdownTable(rest).length > 0 ? parseMarkdownTable(rest) : parseList(rest);
    if (rows.length >= 2) {
      return { title: heading ?? fallbackTitle, rows };
    }
  }
  return null;
}
