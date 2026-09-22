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
  /**
   * 자리별 사용자 요구사항(2026-09-22 "🖼 이미지 수정"). 키는 자리 번호 문자열.
   * 사람이 결과를 보고 "2번은 인물 단독샷으로" 같이 적어 보낸 것이라, 마커 설명보다 **우선**한다.
   */
  requirements?: Record<string, string>;
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
  const requirements = input.requirements ?? {};
  const slots = buildWebImageSlots(input.body, input.imagePrompts)
    .filter((s) => !filled.has(s.index))
    // 사용자가 적어 보낸 요구를 **검색어와 판정 기준 양쪽에** 얹는다.
    //
    // 2026-09-22 실측 사고: 처음에는 설명(판정 기준)에만 붙였다. 그러자 검색은 옛 검색어로 하고
    // 판정만 빡빡해져서, 네 후보가 전부 "요청한 투샷이 아니다"로 탈락하고 자리가 비었다.
    // 아침에 마커 정렬에서 고친 "검색은 A, 판정은 B"를 그대로 다시 만든 셈이었다.
    //
    // 사용자가 검색어를 직접 지정하는 경우가 대부분이라("SNL 주현영과 김원훈 으로 검색해서")
    // **요구사항을 검색어로 쓰고**, 원래 검색어는 뒤에 남겨 맥락을 잃지 않게 한다.
    .map((slot) => {
      const want = requirements[String(slot.index)];
      if (!want) return slot;
      return {
        ...slot,
        query: want,
        description: `${slot.description} (사용자 요청: ${want})`,
      };
    });
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
