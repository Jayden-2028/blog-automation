// 원고 본문을 텍스트/이미지 블록으로 나눈다.
//
// writer.md §8은 집필 단계 산출물(drafts/*.md)에 [IMAGE: 설명] 다음 줄에 [IMAGE PROMPT: ...]를
// 붙여 쓰라고 하지만, 그 파일이 DB(articles.content)로 들어갈 때 parseDraftFile.ts의
// extractImagePrompts()가 [IMAGE PROMPT:] 줄을 본문에서 빼내 job.metadata.imagePrompts 배열로
// 따로 저장한다(발행 본문에 안 넣으려는 의도적 설계, runArticleJob.ts 참고). 그래서 이 파이프라인이
// 실제로 다루는 본문(기준 원고 DB content, 그리고 그 본문을 그대로 베낀 배리에이션)에는
// [IMAGE: 설명] 단독 줄만 있고 프롬프트가 없다 - 프롬프트는 본문에 나오는 순서대로
// imagePrompts[i]와 짝을 맞춰야 한다.
//
// 순서가 어긋나면(배리에이션이 마커를 빠뜨리거나 추가하면) 엉뚱한 이미지에 엉뚱한 프롬프트를
// 붙이는 것보다는 프롬프트 없이 보여주는 편이 안전하다 - 그래서 마커 개수와 imagePrompts 길이가
// 다르면 그 문서 전체를 "프롬프트 미상"으로 처리한다.

export type ManuscriptBlock =
  | { type: "text"; content: string }
  | { type: "image"; description: string; prompt: string | null };

const IMAGE_LINE_RE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;

export function parseManuscriptBlocks(body: string, imagePrompts: string[] = []): ManuscriptBlock[] {
  const lines = body.split("\n");
  const markerCount = lines.filter((line) => IMAGE_LINE_RE.test(line.trim())).length;
  const promptsAligned = markerCount > 0 && markerCount === imagePrompts.length;

  const blocks: ManuscriptBlock[] = [];
  let textBuffer: string[] = [];
  let imageIndex = 0;

  const flushText = () => {
    const text = textBuffer.join("\n").trim();
    if (text.length > 0) blocks.push({ type: "text", content: text });
    textBuffer = [];
  };

  for (const line of lines) {
    const match = IMAGE_LINE_RE.exec(line.trim());
    if (match) {
      flushText();
      blocks.push({
        type: "image",
        description: match[1].trim(),
        prompt: promptsAligned ? imagePrompts[imageIndex] : null,
      });
      imageIndex += 1;
    } else {
      textBuffer.push(line);
    }
  }
  flushText();

  return blocks;
}

/** 이미지 마커 줄을 뺀 본문. "복사" 버튼이 붙여넣을 때 마커 텍스트가 섞이지 않게 한다. */
export function manuscriptBodyWithoutImages(body: string): string {
  return body
    .split("\n")
    .filter((line) => !IMAGE_LINE_RE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
