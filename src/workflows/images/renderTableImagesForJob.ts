// `— 표 생성` 이미지 자리를 본문 데이터로 그려 Storage에 올린다. prepareManuscript가 부른다.
//
// 생성(AI)·수집(웹 검색)과 나란한 세 번째 경로다. 셋이 서로 배타적인 이유는 자리의 성격이 다르기
// 때문이다(output-format.md §8-4):
//   AI 생성  - 실물 특정이 필요 없는 장면
//   웹 검색  - 특정 인물·제품·장소의 실제 모습
//   표 생성  - 정보가 글자로 전달되는 것(일정·순위·금액). 생성도 검색도 못 하는 자리다.

import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import { keywordSlug } from "../../config/pipelinePaths.js";
import { extractTableData } from "./extractTableData.js";
import { renderTableImage } from "./renderTableImage.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

export type RenderTableImagesForJobInput = {
  jobId: string;
  body: string;
  imagePrompts: string[];
  /** 이미 채워진 자리 번호. 여기 있는 자리는 건너뛴다. */
  filledIndexes?: number[];
};

export type RenderTableImagesForJobOptions = {
  render?: typeof renderTableImage;
  upload?: (input: {
    index: number;
    buffer: Buffer;
    mimeType: string;
  }) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
};

export async function renderTableImagesForJob(
  input: RenderTableImagesForJobInput,
  options: RenderTableImagesForJobOptions = {}
): Promise<{ images: ManuscriptImage[]; failures: string[] }> {
  const render = options.render ?? renderTableImage;
  const filled = new Set(input.filledIndexes ?? []);

  const blocks = parseManuscriptBlocks(input.body, input.imagePrompts);
  const images: ManuscriptImage[] = [];
  const failures: string[] = [];

  // 이미지 블록 순서(1부터)를 세면서, 표 생성 자리를 만나면 **그 앞까지의 블록들**을 데이터 후보로 넘긴다.
  const preceding: string[] = [];
  let imageIndex = 0;

  for (const block of blocks) {
    if (block.type !== "image") {
      preceding.push(block.type === "heading" ? `**${block.heading}**\n${block.body}` : block.content);
      continue;
    }

    imageIndex += 1;
    if (block.acquisition !== "table" || filled.has(imageIndex)) continue;

    const data = extractTableData(preceding, block.description.replace(/\s*—\s*표\s*생성\s*$/, "").trim());
    if (!data) {
      failures.push(`[자리 ${imageIndex}] 표로 그릴 데이터를 본문에서 찾지 못했습니다(앞 문단에 표나 목록이 있어야 합니다).`);
      continue;
    }

    const rendered = await render(data);
    if (!rendered.ok) {
      failures.push(`[자리 ${imageIndex}] 표 렌더링 실패: ${rendered.error}`);
      continue;
    }

    const uploaded = options.upload
      ? await options.upload({ index: imageIndex, buffer: rendered.buffer, mimeType: rendered.mimeType })
      : await uploadArticleImage({
          jobId: input.jobId,
          index: imageIndex,
          variant: "table",
          imageBuffer: rendered.buffer,
          mimeType: rendered.mimeType,
        }).then((r) => (r.ok ? ({ ok: true, url: r.url } as const) : ({ ok: false, error: r.error } as const)));

    if (!uploaded.ok) {
      failures.push(`[자리 ${imageIndex}] 표 이미지 업로드 실패: ${uploaded.error}`);
      continue;
    }

    images.push({
      index: imageIndex,
      description: block.description,
      prompt: null,
      url: uploaded.url,
      provider: "table",
      fileName: `${String(imageIndex).padStart(2, "0")}-${keywordSlug(data.title).slice(0, 40) || "table"}.png`,
      error: null,
    });
  }

  return { images, failures };
}
