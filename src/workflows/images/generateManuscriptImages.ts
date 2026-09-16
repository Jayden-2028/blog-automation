// writer가 원고에 남긴 [IMAGE: 설명] + [IMAGE PROMPT: ...] 쌍으로 실제 이미지를 만든다
// (BLOGSPOT_ONLY_DESIGN.md §3). 승인된 원고에만 돈다 - prepareManuscript가 호출한다.
//
// 왜 브리프를 새로 묻지 않는가: writer는 그 문단의 문맥을 보고 프롬프트를 썼다. 여기서 LLM에
// 다시 "이 글에 어울리는 이미지를 기획해줘"라고 물으면 문맥이 한 번 더 세탁되고 호출도 늘어난다.
// 옛 경로(workflows/writing/generateArticleImages.ts)는 본문에 마크다운까지 끼워 넣었는데, 그러면
// 뷰어의 블록 파싱이 이미 자리를 잡아 둔 [IMAGE:] 마커와 이중으로 겹친다 - 그래서 이 모듈은
// **본문을 건드리지 않는다.** 만든 이미지는 manifest에만 얹고, 뷰어가 마커 자리에 끼워 그린다.
//
// best-effort다. 한 장이 실패해도 나머지는 계속 만들고, 전부 실패해도 원고 준비 자체는 성공이다
// (뷰어는 그 자리에 프롬프트만 보여준다).

import { MANUSCRIPT_IMAGE_CONFIG } from "../../config/manuscriptImages.js";
import { keywordSlug } from "../../config/pipelinePaths.js";
import { generateImage, resolveImageProvider } from "../../services/images/generateImage.js";
import type { GenerateImageResult, ImageProvider } from "../../services/images/generateImage.js";
import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import type { UploadArticleImageResult } from "../../services/supabase/storage/uploadArticleImage.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import type { ManuscriptBlock } from "../manuscripts/parseManuscriptBlocks.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

export type GenerateManuscriptImagesInput = {
  jobId: string;
  keyword: string;
  /** Asia/Seoul YYYY-MM-DD. 로컬 미러 경로를 만들 때 쓴다. */
  date: string;
  /** 확정된 원고 본문(마크다운). [IMAGE: 설명] 마커가 그대로 들어 있다. */
  body: string;
  /** job.metadata.imagePrompts. 본문 마커와 순서가 1:1로 맞아야 한다. */
  imagePrompts: string[];
};

export type GenerateManuscriptImagesOptions = {
  /** 테스트 주입 지점. 기본은 실제 generateImage / uploadArticleImage. */
  generate?: typeof generateImage;
  upload?: typeof uploadArticleImage;
  config?: typeof MANUSCRIPT_IMAGE_CONFIG;
  /** 비교 모드에서 쓸 provider 목록. 기본 ["openai", "gemini"]. */
  providers?: ImageProvider[];
};

export type GenerateManuscriptImagesResult = {
  images: ManuscriptImage[];
  failures: string[];
};

/** 확장자 없는 안전한 파일명 조각. 설명이 길면 자른다. */
function fileStem(index: number, description: string): string {
  const slug = keywordSlug(description).slice(0, 40).replace(/-+$/, "");
  return `${String(index).padStart(2, "0")}-${slug || "image"}`;
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export async function generateManuscriptImages(
  input: GenerateManuscriptImagesInput,
  options: GenerateManuscriptImagesOptions = {}
): Promise<GenerateManuscriptImagesResult> {
  const config = options.config ?? MANUSCRIPT_IMAGE_CONFIG;
  if (!config.enabled) {
    return { images: [], failures: [] };
  }

  const generate = options.generate ?? generateImage;
  const upload = options.upload ?? uploadArticleImage;
  const providers: ImageProvider[] = config.abCompare
    ? options.providers ?? ["openai", "gemini"]
    : [resolveImageProvider()];

  // 본문 마커와 프롬프트의 짝은 parseManuscriptBlocks가 이미 검증한다(개수가 안 맞으면 prompt=null).
  // 프롬프트 없는 마커는 생성 대상이 아니다 - 억지로 설명(한국어)을 프롬프트로 쓰면 품질이 크게
  // 떨어지고 저작권 가드(실존 인물·로고 회피)가 프롬프트에 안 실린다.
  const imageBlocks = parseManuscriptBlocks(input.body, input.imagePrompts).filter(
    (b): b is Extract<ManuscriptBlock, { type: "image" }> => b.type === "image"
  );

  const images: ManuscriptImage[] = [];
  const failures: string[] = [];

  // `웹 검색` 마커는 애초에 생성 대상이 아니다(2026-09-16). 그 마커의 프롬프트는 검색창에 칠
  // 한국어 검색어라, 이미지 모델에 넣으면 규격 밖 프롬프트로 저품질 이미지가 나온다 -
  // parseManuscriptBlocks의 ImageAcquisition 주석에 실측 경위가 있다. 이 자리는 사람이(또는 Codex가)
  // 실제 사진을 찾아 채우고, 뷰어는 채워지지 않은 자리로 잡아 "발행 전 채울 것"에 검색어와 함께 띄운다.
  //
  // index는 **원래 마커 순서**(1-based)를 유지한다 - 뷰어(renderManuscriptPage)가 이 번호로 본문 블록과
  // 이미지를 짝지으므로, 건너뛴 자리만큼 번호를 당기면 이미지가 엉뚱한 문단에 붙는다.
  const aiSlots = imageBlocks
    .map((block, i) => ({ block, index: i + 1 }))
    .filter(({ block }) => block.acquisition !== "search");

  const targets = aiSlots.slice(0, config.maxPerArticle);
  if (aiSlots.length > targets.length) {
    failures.push(`AI 생성 대상 ${aiSlots.length}개 중 상한(${config.maxPerArticle})까지만 생성했습니다.`);
  }

  for (const { block, index } of targets) {
    if (!block.prompt) {
      failures.push(`[이미지 ${index}] 프롬프트를 찾지 못해 건너뜁니다(마커 수와 imagePrompts 길이 불일치).`);
      images.push({
        index,
        description: block.description,
        prompt: null,
        url: null,
        provider: null,
        fileName: `${fileStem(index, block.description)}.png`,
        error: "프롬프트 없음",
      });
      continue;
    }

    for (const provider of providers) {
      // 순차 호출이다. 병렬로 돌리면 같은 API 키에 동시 요청이 몰려 rate limit에 걸리고,
      // 어차피 GH Actions의 heavy-pipeline 큐가 실행을 하나로 직렬화하고 있어 얻을 게 없다.
      const result: GenerateImageResult = await generate({ prompt: block.prompt }, provider);
      const variant = providers.length > 1 ? provider : undefined;
      const stem = fileStem(index, block.description);

      if (!result.ok) {
        failures.push(`[이미지 ${index}/${provider}] 생성 실패: ${result.error}`);
        images.push({
          index,
          description: block.description,
          prompt: block.prompt,
          url: null,
          provider,
          fileName: `${stem}${variant ? `-${variant}` : ""}.png`,
          error: result.error,
        });
        continue;
      }

      const uploaded: UploadArticleImageResult = await upload({
        jobId: input.jobId,
        index,
        variant,
        imageBuffer: result.imageBuffer,
        mimeType: result.mimeType,
      });

      const fileName = `${stem}${variant ? `-${variant}` : ""}.${extensionFor(result.mimeType)}`;

      if (!uploaded.ok) {
        failures.push(`[이미지 ${index}/${provider}] 업로드 실패: ${uploaded.error}`);
        images.push({
          index,
          description: block.description,
          prompt: block.prompt,
          url: null,
          provider,
          fileName,
          error: uploaded.error,
        });
        continue;
      }

      images.push({
        index,
        description: block.description,
        prompt: block.prompt,
        url: uploaded.url,
        provider,
        fileName,
        error: null,
      });
    }
  }

  return { images, failures };
}

/** 로컬 미러 경로(manuscripts/<날짜>/<주제 슬러그>/<파일명>)의 디렉터리 부분. syncManuscriptImages가 쓴다. */
export function localImageDirFor(date: string, keyword: string): string[] {
  return [date, keywordSlug(keyword)];
}
