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
import { captureRankingImage, matchRankingSource } from "./captureRankingImage.js";
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
  /**
   * 등록된 순위 사이트(펀덱스·CGV) 캡처. 기본은 실제 캡처. false면 건너뛰고 본문 데이터로만 그린다
   * (테스트 - 외부 사이트를 열면 안 된다).
   */
  captureRanking?: false | typeof captureRankingImage;
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

    const label = block.description.replace(/\s*—\s*표\s*생성\s*$/, "").trim();

    // TV 화제성·박스오피스 순위처럼 **우리가 가진 데이터가 아닌** 순위는 원본 사이트를 캡처한다
    // (2026-09-18 사용자 지정). 웹 검색으로는 못 찾고(기사 텍스트로만 존재) 우리가 그릴 수도 없다.
    const captureRanking = options.captureRanking === undefined ? captureRankingImage : options.captureRanking;
    const rankingSource = captureRanking ? matchRankingSource(label) : null;

    let rendered: { ok: true; buffer: Buffer; mimeType: string } | { ok: false; error: string };
    let attribution: string | null = null;
    let sourcePage: string | null = null;

    if (rankingSource && captureRanking) {
      const captured = await captureRanking(rankingSource);
      if (captured.ok) {
        rendered = captured;
        attribution = rankingSource.attribution;
        sourcePage = rankingSource.url;
      } else {
        // 캡처가 막히면(봇 차단·개편) 본문 데이터로 그리는 원래 경로로 되돌아간다.
        failures.push(`[자리 ${imageIndex}] ${rankingSource.label} 캡처 실패, 본문 데이터로 그립니다: ${captured.error}`);
        rendered = { ok: false, error: captured.error };
      }
    } else {
      rendered = { ok: false, error: "" };
    }

    if (!rendered.ok) {
      const data = extractTableData(preceding, label);
      if (!data) {
        failures.push(`[자리 ${imageIndex}] 표로 그릴 데이터를 본문에서 찾지 못했습니다(앞 문단에 표나 목록이 있어야 합니다).`);
        continue;
      }
      rendered = await render(data);
      if (!rendered.ok) {
        failures.push(`[자리 ${imageIndex}] 표 렌더링 실패: ${rendered.error}`);
        continue;
      }
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
      provider: sourcePage ? "ranking" : "table",
      fileName: `${String(imageIndex).padStart(2, "0")}-${keywordSlug(label).slice(0, 40) || "table"}.${
        rendered.mimeType.includes("jpeg") ? "jpg" : "png"
      }`,
      error: null,
      // 캡처한 순위표는 남의 화면이다 - 출처를 캡션에 남긴다(§8-2 공식 사이트 예외 조건).
      sourcePage,
      license: attribution,
    });
  }

  return { images, failures };
}
