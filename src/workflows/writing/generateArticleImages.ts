// 원고 본문에 AI 생성 이미지를 삽입한다(SPRINT_3_DESIGN.md 이미지 파트 재작업, 2026-08-28 사용자
// 요청). 이전 버전(buildImageBrief.ts만 있던 시절)은 브리프를 Telegram으로 보내고 사용자가
// ChatGPT에서 수동으로 이미지를 만들어야 했다 - 사용자가 "이미지가 첨부된 원고 풀세트"를
// 요청하면서 API 키(OPENAI_API_KEY)를 직접 제공해, 생성부터 삽입까지 전 과정을 자동화한다.
//
// 왜 여러 지점에 나눠 넣는가: 대표 이미지 1장만으로는 "이미지가 첨부된 원고"라는 요청에 못 미친다.
// 본문 섹션(**소제목** 볼드 한 줄, writer.md §6)에 맞춰 장면을 다르게 기획해 섹션마다 다른 이미지를 넣는다.
//
// best-effort인 이유: 이미지 생성/업로드가 실패해도 원고 자체(텍스트)는 이미 완성돼 있다. 이미지
// 하나가 실패했다고 원고 전체를 버리면 안 된다 - 실패한 지점은 그냥 이미지 없이 넘어가고,
// 실패 목록을 결과에 남겨 검수 단계에서 사람이 알 수 있게 한다.

import { buildImageBrief } from "./buildImageBrief.js";
import type { BuildImageBriefResult } from "./buildImageBrief.js";
import { generateImage, resolveImageProvider } from "../../services/images/generateImage.js";
import type { GenerateImageResult, ImageProvider } from "../../services/images/generateImage.js";
import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import type { UploadArticleImageResult } from "../../services/supabase/storage/uploadArticleImage.js";

/** 원고 1건당 기본 이미지 수(사용자 결정, 2026-08-28) - 섹션별로 2~3장. */
export const DEFAULT_MAX_IMAGES = 3;

export type ArticleImageInsertionPoint = {
  /** 사람이 읽을 위치 설명(로그·실패 메시지용). */
  label: string;
  /** null이면 도입부(첫 문단) 바로 뒤에 넣는다. 그 외에는 정확히 일치하는 "**제목**" 볼드 블록 뒤에 넣는다. */
  insertAfterHeading: string | null;
};

const HEADING_LINE_RE = /^\*\*(.+)\*\*$/;

/**
 * 본문에서 이미지를 넣을 지점을 고른다. 첫 지점은 항상 도입부(대표 이미지)이고, 나머지는
 * `**소제목**` 볼드 한 줄 중 '참고 자료'를 제외한 것에서 앞쪽부터 간격을 두고 고른다 - 뒤로 갈수록
 * 다음 소제목이 없을 수 있으므로 실제로 찾은 개수만큼만 돌려준다(요청한 개수를 못 채워도 실패가 아니다).
 */
export function pickInsertionPoints(body: string, maxImages: number): ArticleImageInsertionPoint[] {
  if (maxImages <= 0) return [];

  const points: ArticleImageInsertionPoint[] = [{ label: "도입부(대표 이미지)", insertAfterHeading: null }];
  if (maxImages === 1) return points;

  const headings = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => HEADING_LINE_RE.test(line))
    .filter((line) => !/참고\s*자료/.test(line));

  const remaining = maxImages - 1;
  // 소제목이 remaining보다 많으면 앞쪽 remaining개만 쓴다 - 뒤로 갈수록 결론/참고자료 구간이라
  // 이미지가 어울리지 않는 경우가 많고, 앞쪽 섹션이 대개 핵심 정보를 담고 있다.
  const chosenHeadings = headings.slice(0, remaining);
  for (const heading of chosenHeadings) {
    points.push({ label: heading.replace(HEADING_LINE_RE, "$1"), insertAfterHeading: heading });
  }

  return points;
}

/**
 * 지점 뒤에 이미지 마크다운을 끼워 넣는다. 문단(빈 줄 2개) 단위로 나눠 다루는데, 소제목은 이제
 * 그 블록의 첫 줄일 뿐 블록 전체가 아니므로(writer.md §6 - 소제목 바로 다음 줄에 문단이 붙는다)
 * 블록 전체가 아니라 **첫 줄**이 헤더와 일치하는지로 찾는다.
 */
function insertImageMarkdown(body: string, point: ArticleImageInsertionPoint, imageMarkdown: string): string {
  const blocks = body.split(/\n{2,}/);

  if (point.insertAfterHeading === null) {
    // 도입부: 첫 블록(보통 헤더가 아닌 순수 문단) 바로 뒤에 넣는다.
    blocks.splice(1, 0, imageMarkdown);
    return blocks.join("\n\n");
  }

  const index = blocks.findIndex((block) => block.split("\n")[0]?.trim() === point.insertAfterHeading);
  if (index === -1) return body; // 못 찾으면 원본 그대로 - 위치를 못 찾았다고 이미지를 억지로 붙이지 않는다.

  blocks.splice(index + 1, 0, imageMarkdown);
  return blocks.join("\n\n");
}

export type GeneratedArticleImage = {
  insertionLabel: string;
  imageUrl: string;
  altText: string;
  prompt: string;
  provider: ImageProvider;
  copyrightStatus: string;
};

export type GenerateArticleImagesInput = {
  jobId: string;
  title: string;
  keyword: string;
  category: string | null;
  seoDescription?: string | null;
  body: string;
  maxImages?: number;
};

export type GenerateArticleImagesOptions = {
  /** 테스트 주입 지점. 기본은 실제 buildImageBrief/generateImage/uploadArticleImage를 그대로 쓴다. */
  planBrief?: typeof buildImageBrief;
  generate?: typeof generateImage;
  upload?: typeof uploadArticleImage;
  provider?: ImageProvider;
};

export type GenerateArticleImagesResult = {
  /** 이미지 마크다운이 삽입된 본문. 실패한 지점은 그대로 비어 있다(원문 유지). */
  body: string;
  images: GeneratedArticleImage[];
  /** 실패한 지점의 사유. 원고 자체는 계속 진행하되 검수 단계에서 보여줄 수 있게 남긴다. */
  failures: string[];
};

async function generateOneImage(
  point: ArticleImageInsertionPoint,
  index: number,
  input: GenerateArticleImagesInput,
  options: GenerateArticleImagesOptions
): Promise<{ point: ArticleImageInsertionPoint; image: GeneratedArticleImage } | { point: ArticleImageInsertionPoint; error: string }> {
  const planBrief = options.planBrief ?? buildImageBrief;
  const generate = options.generate ?? generateImage;
  const upload = options.upload ?? uploadArticleImage;
  const provider = options.provider ?? resolveImageProvider();

  const briefResult: BuildImageBriefResult = await planBrief({
    title: input.title,
    keyword: input.keyword,
    category: input.category,
    seoDescription: input.seoDescription,
    sectionHint: point.label,
  });
  if (!briefResult.ok) return { point, error: `[${point.label}] 브리프 생성 실패: ${briefResult.error}` };

  const imageResult: GenerateImageResult = await generate({ prompt: briefResult.brief.prompt }, provider);
  if (!imageResult.ok) return { point, error: `[${point.label}] 이미지 생성 실패: ${imageResult.error}` };

  const uploadResult: UploadArticleImageResult = await upload({
    jobId: input.jobId,
    index,
    imageBuffer: imageResult.imageBuffer,
    mimeType: imageResult.mimeType,
  });
  if (!uploadResult.ok) return { point, error: `[${point.label}] 업로드 실패: ${uploadResult.error}` };

  return {
    point,
    image: {
      insertionLabel: point.label,
      imageUrl: uploadResult.url,
      altText: briefResult.brief.altText || input.title,
      prompt: briefResult.brief.prompt,
      provider: imageResult.provider,
      copyrightStatus: `ai-generated:${imageResult.provider}`,
    },
  };
}

export async function generateArticleImages(
  input: GenerateArticleImagesInput,
  options: GenerateArticleImagesOptions = {}
): Promise<GenerateArticleImagesResult> {
  const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES;
  const points = pickInsertionPoints(input.body, maxImages);

  const images: GeneratedArticleImage[] = [];
  const failures: string[] = [];
  let body = input.body;

  // 순차 처리한다(병렬 아님) - 삽입 지점을 body 안에서 하나씩 찾아 넣어야 하므로, 병렬로 하면
  // 앞선 삽입이 뒤 블록의 인덱스를 밀어내 다음 지점 탐색이 어긋난다.
  for (let i = 0; i < points.length; i++) {
    const outcome = await generateOneImage(points[i], i + 1, input, options);
    if ("error" in outcome) {
      failures.push(outcome.error);
      continue;
    }

    images.push(outcome.image);
    body = insertImageMarkdown(body, outcome.point, `![${outcome.image.altText}](${outcome.image.imageUrl})`);
  }

  return { body, images, failures };
}
