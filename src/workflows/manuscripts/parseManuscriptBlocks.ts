// 원고 본문을 소제목/텍스트/이미지 블록으로 나눈다. 문단 경계는 빈 줄 1개 이상(writer.md §6·§7과
// 같은 관례 - convertArticleToHtml.ts/convertArticleToNaverHtml.ts와 동일한 블록 분할 기준을
// 써서, 이 페이지에서 보이는 블록과 채널별 HTML 변환 결과의 블록이 1:1로 대응하게 한다).
//
// writer.md §6(2026-09-06)부터 소제목은 "**볼드**" 한 줄이고, 바로 다음 줄에 빈 줄 없이 그 소제목의
// 첫 문단이 붙는다 - 그래서 소제목과 그 문단은 같은 블록(같은 `\n{2,}` 구간) 안에 있다.
//
// writer.md §8은 집필 단계 산출물(drafts/*.md)에 [IMAGE: 설명] 다음 줄에 [IMAGE PROMPT: ...]를
// 붙여 쓰라고 하지만, 그 파일이 DB(articles.content)로 들어갈 때 parseDraftFile.ts의
// extractImagePrompts()가 [IMAGE PROMPT:] 줄을 본문에서 빼내 job.metadata.imagePrompts 배열로
// 따로 저장한다(발행 본문에 안 넣으려는 의도적 설계, runArticleJob.ts 참고). 그래서 이 파이프라인이
// 다루는 본문 대부분은 [IMAGE: 설명] 단독 줄만 있고 프롬프트가 없다 - 프롬프트는 본문에 나오는
// 순서대로 imagePrompts[i]와 짝을 맞춰야 한다.
//
// 다만 일부 채널 원고(articles.content)는 [IMAGE: 설명] 바로 다음 줄에 [IMAGE PROMPT: ...]가
// 이미 붙은 채로 저장돼 있다(2026-09-15 발견 - 로컬 .md 파일 전용이어야 할 reinsertImagePrompts
// 결과가 그대로 DB에도 들어간 과거 이력). 이 형태를 텍스트 블록으로 오인하면 이미지 캡션 표·
// 이미지 프롬프트 팩 버튼이 통째로 안 뜬다 - 그래서 "[IMAGE:]" 한 줄+"[IMAGE PROMPT:]" 한 줄
// 조합도 이미지 블록으로 인식하고, 그 경우엔 인라인 프롬프트를 그대로 쓴다(같은 줄에 붙어 있어
// 배열 순서 정렬보다 더 확실하다).
//
// 순서가 어긋나면(배리에이션이 마커를 빠뜨리거나 추가하면) 엉뚱한 이미지에 엉뚱한 프롬프트를
// 붙이는 것보다는 프롬프트 없이 보여주는 편이 안전하다 - 그래서 마커 개수와 imagePrompts 길이가
// 다르면(그리고 인라인 프롬프트도 없으면) 그 문서 전체를 "프롬프트 미상"으로 처리한다.

export type ManuscriptBlock =
  | { type: "text"; content: string }
  | { type: "heading"; heading: string; body: string }
  | { type: "image"; description: string; prompt: string | null };

const IMAGE_LINE_RE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;
const IMAGE_PROMPT_LINE_RE = /^\[IMAGE PROMPT:\s*([\s\S]*?)\]\s*$/;
const HEADING_LINE_RE = /^\*\*(.+)\*\*$/;

/** raw 블록이 이미지 마커(단독, 또는 바로 다음 줄에 IMAGE PROMPT가 붙은 형태)인지 판정한다. */
function matchImageBlock(raw: string): { description: string; inlinePrompt: string | null } | null {
  const lines = raw.split("\n");
  const first = lines[0].match(IMAGE_LINE_RE);
  if (!first) return null;
  if (lines.length === 1) return { description: first[1].trim(), inlinePrompt: null };
  if (lines.length === 2) {
    const second = lines[1].match(IMAGE_PROMPT_LINE_RE);
    if (second) return { description: first[1].trim(), inlinePrompt: second[1].trim() };
  }
  return null;
}

export function parseManuscriptBlocks(body: string, imagePrompts: string[] = []): ManuscriptBlock[] {
  const rawBlocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const markerCount = rawBlocks.filter((b) => matchImageBlock(b) !== null).length;
  const promptsAligned = markerCount > 0 && markerCount === imagePrompts.length;

  const blocks: ManuscriptBlock[] = [];
  let imageIndex = 0;

  for (const raw of rawBlocks) {
    const imageMatch = matchImageBlock(raw);
    if (imageMatch) {
      blocks.push({
        type: "image",
        description: imageMatch.description,
        prompt: imageMatch.inlinePrompt ?? (promptsAligned ? imagePrompts[imageIndex] : null),
      });
      imageIndex += 1;
      continue;
    }

    const lines = raw.split("\n");
    const headingMatch = lines[0].match(HEADING_LINE_RE);
    if (headingMatch) {
      blocks.push({ type: "heading", heading: headingMatch[1].trim(), body: lines.slice(1).join("\n").trim() });
      continue;
    }

    blocks.push({ type: "text", content: raw });
  }

  return blocks;
}

/** 이미지 마커 줄(과 바로 붙은 IMAGE PROMPT 줄)을 뺀 본문. "복사" 버튼이 붙여넣을 때 마커
 *  텍스트가 섞이지 않게 한다. */
export function manuscriptBodyWithoutImages(body: string): string {
  return body
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !IMAGE_LINE_RE.test(trimmed) && !IMAGE_PROMPT_LINE_RE.test(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
