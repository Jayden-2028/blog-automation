// 게시물에서 읽어낸 것(InstagramCaptureResult) -> article_jobs 1건.
//
// 하는 일은 저장뿐이다: job 생성 -> 큐 항목 완료 표시. 브라우저·모델이 필요한 일은 전부
// runCaptureSession 쪽에서 끝나 있다.
//
// 2026-09-23 재설계로 **이미지 업로드가 사라졌다.** 게시물 사진을 원고에 쓰지 않기 때문이다.
// metadata에 남기는 것은 글자뿐이고(캡션·번인 텍스트·원본 주소), 그 글자는 runArticleJob의
// buildInstagramSourceContext가 조사 프롬프트의 1차 근거로 넣는다. 원고 이미지는 주제가
// 정해진 뒤 기존 파이프라인(웹 검색 + 필요시 생성)이 채운다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { markEntry } from "./instagramQueue.js";
import type { InstagramCaptureResult } from "./types.js";

export type CreateInstagramJobResult = { jobId: string };

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
    },
  });

  markEntry(capture.queueEntryId, { status: "done", jobId: job.id });

  return { jobId: job.id };
}
