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
import { recordApiUsage } from "../../services/usage/recordApiUsage.js";
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
  /** 비용 원장 기록. 테스트에서 Supabase를 타지 않도록 주입 지점을 연다. */
  record?: typeof recordApiUsage;
  /**
   * 지정하면 이 마커 번호(1부터)만 생성한다. 이미 이미지가 있는 원고에서 **빈 자리만** 채울 때 쓴다
   * (images:fill). 생략하면 지금까지처럼 AI 생성 자리 전부가 대상이다.
   */
  onlyIndexes?: number[];
  /**
   * 본문에는 `웹 검색`으로 적혀 있지만 **웹에서 못 찾아 AI로 대신 채울 자리**(2026-09-17).
   * 여기 들어온 자리는 acquisition 필터를 건너뛰고 아래 생성 루프를 그대로 탄다.
   *
   * 왜 별도 루프를 만들지 않는가: 생성·업로드·원장 기록·실패 기록이 이미 한 벌 있는데 폴백용으로
   * 한 벌 더 만들면 둘이 갈라진다(이번 세션에만 같은 실수를 세 번 했다). 입력만 얹고 경로는 공유한다.
   */
  fallbackSlots?: { index: number; description: string; prompt: string }[];
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
  const record = options.record ?? recordApiUsage;
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
  const onlyIndexes = options.onlyIndexes ? new Set(options.onlyIndexes) : null;
  // **화이트리스트로 고른다**(2026-09-18). 전에는 `!== "search"`라 `표 생성` 자리까지 AI 생성
  // 대상이었다. prepareManuscript가 AI 생성을 먼저 돌리고 표 렌더를 나중에 돌리므로(이미 채워진
  // 자리는 건너뛴다) **AI가 표 자리를 선점하면 표는 영영 안 그려진다.**
  // 실측(2026-09-18): 정부지원금 [3][4][6]과 노크노크 [6]이 전부 그렇게 AI 사진으로 채워졌다 -
  // 캡션은 "표 생성"인데 그림은 폰 보는 남자였다(사용자 반려).
  // `unknown`은 획득 방식 접미사가 없던 옛 원고라 종전대로 AI로 둔다.
  const aiSlots = imageBlocks
    .map((block, i) => ({ block, index: i + 1 }))
    .filter(({ block }) => block.acquisition === "ai" || block.acquisition === "unknown")
    .filter(({ index }) => !onlyIndexes || onlyIndexes.has(index));

  // 웹 수집이 실패해 AI로 돌려받은 자리를 같은 대상 목록에 합친다. 본문 마커의 acquisition은
  // `search` 그대로 두므로(원고는 원고대로 정확해야 한다) 여기서만 예외적으로 생성한다.
  for (const slot of options.fallbackSlots ?? []) {
    if (aiSlots.some(({ index }) => index === slot.index)) continue;
    aiSlots.push({
      block: { type: "image", description: slot.description, prompt: slot.prompt, acquisition: "search" },
      index: slot.index,
    });
  }
  aiSlots.sort((a, b) => a.index - b.index);

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

      // 성공한 호출만 원장에 남긴다. 실패 응답(4xx/5xx·타임아웃)은 과금되지 않으므로 $0짜리 행을
      // 쌓으면 "호출 N건" 같은 수치만 부풀고 금액은 그대로다. 실패는 failures로 이미 드러난다.
      if (result.ok) {
        await record({
          provider,
          model: result.model,
          operation: "image.generate",
          usage: result.usage,
          jobId: input.jobId,
          metadata: { keyword: input.keyword, imageIndex: index },
        });
      }

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
