// `페이지 캡처` 자리를 채운다 - 리서처가 실제로 열어본 URL을 열어 찍는다(2026-09-18 사용자 결정).
//
// 왜 필요한가(실측): 카톡 스타벅스 1+1 원고는 **프로모션 페이지를 찍으면 끝날 일**이었는데 수단이
// 없어 표 3개로 우회했고, 노크노크는 수집기 스스로 "OTT 앱에서 직접 검색해 캡처하는 방식을 권함"
// 이라고 적었다. 웹 검색으로는 못 찾고 AI로도 못 만드는데 **URL만 알면 되는** 자리가 있었다.
//
// URL은 어디서 오는가: 마커의 둘째 줄(`[IMAGE PROMPT: https://...]`)이다. 그 URL은 집필이 지어낸
// 것이 아니라 **리서처가 research 파일 §11에 적어 둔, 실제로 열어본 페이지**여야 한다
// (researcher.md §11 / output-format.md §8-4). 집필이 주소를 창작하면 없는 페이지를 찍게 된다.
//
// 캡처 결과도 비전 검증을 거친다 - 페이지가 개편됐거나 로그인 벽이 뜨면 엉뚱한 화면이 저장되는데,
// 그걸 그대로 싣는 것보다 비우는 편이 낫다. 검증기는 웹 검색과 **같은 것**을 쓴다(chooseImage).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { keywordSlug } from "../../config/pipelinePaths.js";
import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { capturePageImage } from "./captureRankingImage.js";
import { defaultChooseImage } from "./collectWebImages.js";
import type { ChooseImageInput, ChooseImageResult } from "./collectWebImages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

export type CapturePagesForJobInput = {
  jobId: string;
  body: string;
  imagePrompts: string[];
  /** 이미 채워진 자리 번호. 여기 있는 자리는 건너뛴다. */
  filledIndexes?: number[];
};

export type CapturePagesForJobOptions = {
  capture?: typeof capturePageImage;
  /** 찍은 화면이 그 자리에 맞는지 본다. false면 검증 없이 저장한다(테스트). */
  chooseImage?: false | ((input: ChooseImageInput) => Promise<ChooseImageResult>);
  upload?: (input: {
    index: number;
    buffer: Buffer;
    mimeType: string;
  }) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
};

export async function capturePagesForJob(
  input: CapturePagesForJobInput,
  options: CapturePagesForJobOptions = {}
): Promise<{ images: ManuscriptImage[]; failures: string[] }> {
  const capture = options.capture ?? capturePageImage;
  const chooseImage = options.chooseImage === undefined ? defaultChooseImage : options.chooseImage;
  const filled = new Set(input.filledIndexes ?? []);

  const blocks = parseManuscriptBlocks(input.body, input.imagePrompts);
  const images: ManuscriptImage[] = [];
  const failures: string[] = [];

  // 검증기가 파일을 열어 봐야 하므로 잠깐 내려놓을 자리가 필요하다(러너는 곧 사라진다).
  let dir: string | null = null;
  let imageIndex = 0;
  let lastText = "";

  try {
    for (const block of blocks) {
      if (block.type !== "image") {
        lastText = block.type === "heading" ? `${block.heading}\n${block.body}` : block.content;
        continue;
      }
      imageIndex += 1;
      if (block.acquisition !== "capture" || filled.has(imageIndex)) continue;

      const url = (block.prompt ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        failures.push(
          `[자리 ${imageIndex}] 캡처할 URL이 없습니다(둘째 줄에 리서치 §11의 주소를 그대로 넣어야 합니다): ${url.slice(0, 60) || "(빈 값)"}`
        );
        continue;
      }

      const shot = await capture(url);
      if (!shot.ok) {
        failures.push(`[자리 ${imageIndex}] 페이지 캡처 실패(${url}): ${shot.error}`);
        continue;
      }

      const label = block.description.replace(/\s*—\s*페이지\s*캡처\s*$/, "").trim();
      const fileName = `${String(imageIndex).padStart(2, "0")}-${keywordSlug(label).slice(0, 40) || "capture"}.jpg`;

      if (chooseImage) {
        dir ??= await mkdtemp(resolve(tmpdir(), "page-capture-"));
        const filePath = resolve(dir, fileName);
        await writeFile(filePath, shot.buffer);
        const verdict = await chooseImage({
          candidates: [{ number: 1, filePath, alt: label, sourcePage: url }],
          markerDescription: block.description,
          context: lastText,
          keyword: label,
        });
        if (verdict.picked === null) {
          failures.push(`[자리 ${imageIndex}] 캡처한 화면이 그 자리에 맞지 않아 비웁니다(${url}): ${verdict.reason}`);
          continue;
        }
      }

      const uploaded = options.upload
        ? await options.upload({ index: imageIndex, buffer: shot.buffer, mimeType: shot.mimeType })
        : await uploadArticleImage({
            jobId: input.jobId,
            index: imageIndex,
            variant: "capture",
            imageBuffer: shot.buffer,
            mimeType: shot.mimeType,
          }).then((r) => (r.ok ? ({ ok: true, url: r.url } as const) : ({ ok: false, error: r.error } as const)));

      if (!uploaded.ok) {
        failures.push(`[자리 ${imageIndex}] 캡처 업로드 실패: ${uploaded.error}`);
        continue;
      }

      images.push({
        index: imageIndex,
        description: block.description,
        prompt: null,
        url: uploaded.url,
        provider: "capture",
        fileName,
        error: null,
        // 남의 화면이다 - 출처를 캡션에 남긴다.
        sourcePage: url,
        license: `출처: ${safeHost(url)}`,
      });
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  return { images, failures };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
