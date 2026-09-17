// 파이프라인(GitHub Actions)에서 `웹 검색` 이미지 자리를 채운다. prepareManuscript가 원고를 확정한
// 직후 호출한다.
//
// 맥 로컬 CLI(images:collect)와 **같은 collectWebImages를 쓰되 출력만 다르다**: 러너는 곧 사라지므로
// 파일을 보관함에 남기는 대신 Supabase Storage에 올리고, 결과를 manifest의 images로 넘긴다
// (생성 이미지와 같은 자리). 그래야 뷰어가 그리고, npm run sync:images/manuscript:export가 내려받는다.
//
// 왜 이제야 파이프라인에 붙였나(2026-09-18): 어제 만든 수집 경로는 Codex CLI 전용이라 러너에서
// 실행 자체가 불가능했다 - 결과적으로 **한 번도 자동 실행되지 않았고** 웹 검색 자리가 전부 빈 채로
// 발행 대기에 올라갔다. 실행기를 Claude(WebSearch)로 바꾸면서 이 경로가 열렸다.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import { buildWebImageSlots, collectWebImages } from "./collectWebImages.js";
import type { CollectWebImagesOptions, UnfilledSlot } from "./collectWebImages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

export type CollectWebImagesForJobInput = {
  jobId: string;
  keyword: string;
  body: string;
  imagePrompts: string[];
  /** 이미 채워진 자리 번호(생성 이미지 등). 여기 있는 자리는 건너뛴다. */
  filledIndexes?: number[];
};

export type CollectWebImagesForJobResult = {
  images: ManuscriptImage[];
  failures: string[];
  /** 웹에서 못 채운 자리. prepareManuscript가 AI 생성 폴백으로 넘긴다(2026-09-17). */
  unfilled: UnfilledSlot[];
};

export async function collectWebImagesForJob(
  input: CollectWebImagesForJobInput,
  options: CollectWebImagesOptions = {}
): Promise<CollectWebImagesForJobResult> {
  const filled = new Set(input.filledIndexes ?? []);
  const slots = buildWebImageSlots(input.body, input.imagePrompts).filter((s) => !filled.has(s.index));
  if (slots.length === 0) return { images: [], failures: [], unfilled: [] };

  // 검증자(Claude)가 파일을 열어 봐야 하므로 러너 안에 잠깐 내려받았다가 업로드 후 버린다.
  const dir = await mkdtemp(resolve(tmpdir(), "web-images-"));

  try {
    const result = await collectWebImages(
      { keyword: input.keyword, dir, slots },
      {
        ...options,
        upload:
          options.upload ??
          (async ({ index, buffer, mimeType }) => {
            const uploaded = await uploadArticleImage({
              jobId: input.jobId,
              index,
              variant: "web",
              imageBuffer: buffer,
              mimeType,
            });
            return uploaded.ok ? { ok: true, url: uploaded.url } : { ok: false, error: uploaded.error };
          }),
      }
    );

    const images: ManuscriptImage[] = result.found
      .filter((record) => record.storageUrl)
      .map((record) => ({
        index: record.index,
        description: record.alt,
        // 검색어는 이미지 생성 프롬프트가 아니다 - 뷰어의 "프롬프트 팩"에 섞이면 혼란스럽다.
        prompt: null,
        url: record.storageUrl ?? null,
        provider: "web",
        fileName: record.fileName,
        error: null,
        sourcePage: record.sourcePage,
        license: record.license,
      }));

    return { images, failures: result.failures, unfilled: result.unfilled };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
