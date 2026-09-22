// 캡처 결과(InstagramCaptureResult) -> article_jobs 1건.
//
// 캡처(캐러셀 이미지 크롭, 번인 텍스트 읽기, 웹 대체 이미지 탐색)는 브라우저가 필요해 이 파일이
// 하지 않는다 - Claude 인터랙티브 세션이 직접 보고 InstagramCaptureResult를 채워서 이 함수를 부른다.
// 이 함수는 그 결과를 기계적으로 저장만 한다: 이미지 업로드 -> job 생성 -> 큐 항목 완료 표시.
//
// 이미지는 일단 metadata.instagramImages에 "후보"로만 저장한다(뷰어가 바로 쓰는 metadata.images가
// 아니다) - 캡처 시점엔 아직 writer가 원고를 안 써서 [IMAGE: ] 마커가 몇 개 생길지 모른다.
// job:write가 끝난 뒤 promoteInstagramImagesCli.ts(npm run ig:promote-images)가 마커 수에 맞춰
// metadata.images로 옮긴다 - 그때부터 manuscriptManifest.ts의 A/B 비교 규칙(같은 index, provider만
// 다름)을 타고 뷰어에 나란히 보인다.

import { readFile } from "node:fs/promises";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import { markEntry } from "./instagramQueue.js";
import type { InstagramCandidateImage, InstagramCaptureResult } from "./types.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

/** kind -> ManuscriptImage.provider 라벨. 뷰어의 cutpair가 provider 문자열을 그대로 보여준다. */
const PROVIDER_LABEL: Record<InstagramCandidateImage["kind"], string> = {
  instagram_capture: "인스타 원본 캡처",
  web_alternative: "웹 대체 이미지",
};

function guessMimeType(path: string): string {
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/png";
}

export type CreateInstagramJobResult = { jobId: string; imagesSaved: number; imagesFailed: number };

export async function createInstagramJob(capture: InstagramCaptureResult): Promise<CreateInstagramJobResult> {
  const { job } = await ArticleJobRepository.createManual({
    keyword: capture.searchKeyword,
    headline: capture.caption.slice(0, 120) || null,
    category: capture.category,
    metadata: {
      source: "instagram_manual",
      instagramUrl: capture.instagramUrl,
      instagramCaption: capture.caption,
      instagramBurnedInText: capture.burnedInText,
      instagramProfileEmbedUrl: capture.profileEmbedUrl ?? null,
    },
  });

  // slideIndex별로 kind가 다른 후보를 같은 ManuscriptImage.index로 묶는다 - 뷰어가 그 규칙으로
  // 나란히 비교 UI를 그린다(renderManuscriptPage.ts의 cutpair). description/prompt는 원고 작성
  // 단계에서 실제 [IMAGE: ] 마커와 맞춰 채워지므로 여기서는 자리표시자만 둔다.
  const manuscriptImages: ManuscriptImage[] = [];
  let imagesSaved = 0;
  let imagesFailed = 0;

  for (const candidate of capture.images) {
    try {
      const buffer = await readFile(candidate.localPath);
      const mimeType = guessMimeType(candidate.localPath);
      const uploaded = await uploadArticleImage({
        jobId: job.id,
        index: candidate.slideIndex,
        variant: candidate.kind,
        imageBuffer: buffer,
        mimeType,
      });

      if (uploaded.ok) {
        manuscriptImages.push({
          index: candidate.slideIndex,
          description: `인스타그램 게시물 슬라이드 ${candidate.slideIndex}`,
          prompt: null,
          url: uploaded.url,
          provider: PROVIDER_LABEL[candidate.kind],
          fileName: uploaded.path,
          sourcePage: candidate.kind === "web_alternative" ? candidate.sourcePage ?? capture.instagramUrl : capture.instagramUrl,
          license: candidate.note ?? (candidate.kind === "instagram_capture" ? "원본 게시물 캡처 — 사용 전 확인 필요" : null),
        });
        imagesSaved += 1;
      } else {
        imagesFailed += 1;
        console.error(`⚠️ [ig-capture] 이미지 업로드 실패(slide ${candidate.slideIndex}, ${candidate.kind}): ${uploaded.error}`);
      }
    } catch (error) {
      imagesFailed += 1;
      console.error(`⚠️ [ig-capture] 이미지 읽기 실패(${candidate.localPath}):`, error instanceof Error ? error.message : error);
    }
  }

  if (manuscriptImages.length > 0) {
    await ArticleJobRepository.mergeMetadata(job.id, { instagramImages: manuscriptImages });
  }

  markEntry(capture.queueEntryId, { status: "done", jobId: job.id });

  return { jobId: job.id, imagesSaved, imagesFailed };
}
