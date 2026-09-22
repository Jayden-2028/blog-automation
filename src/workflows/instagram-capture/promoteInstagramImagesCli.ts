// npm run ig:promote-images -- <jobId>
//
// metadata.instagramImages(캡처 시점에 저장해 둔 후보, slide 순서 기준) -> metadata.images(뷰어가
// 실제로 쓰는 자리, [IMAGE: ] 마커 순서 기준)로 옮긴다.
//
// 왜 캡처 시점에 바로 안 하는가: 캡처할 때는 아직 writer가 원고를 안 써서 본문에 [IMAGE: ] 마커가
// 몇 개 생길지 모른다(캐러셀 슬라이드 수와 마커 수가 같다는 보장이 없다) - 인덱스를 미리 박으면
// 마커와 어긋난 이미지가 엉뚱한 자리에 들어간다. job:write가 끝나 metadata.imagePrompts(마커 수와
// 정확히 같은 길이)가 생긴 뒤에 이 스크립트로 재배치한다. 그래야 prepareManuscript가 "이미 이미지가
// 있다"고 보고 AI 생성을 건너뛴다(manuscriptManifest.ts readJobManuscriptImages 참고).
//
// 슬라이드 수 != 마커 수일 때: 마커 수만큼만 순서대로 채우고 남는 슬라이드는 버린다(로그만 남김).
// 마커가 더 많으면 남은 자리는 비워 두고 - 승인 전 뷰어에서 사람이 보고 판단한다(정책: 이미지
// 최종 판단은 사용자가 한다).
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("사용법: npm run ig:promote-images -- <jobId>");
    process.exit(1);
  }

  const job = await ArticleJobRepository.findById(jobId);
  if (!job) {
    console.error(`job을 찾을 수 없습니다: ${jobId}`);
    process.exit(1);
  }

  const candidates = job.metadata?.instagramImages as ManuscriptImage[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    console.error(`metadata.instagramImages가 없습니다 - 이 job은 인스타 캡처 후보가 없습니다: ${jobId}`);
    process.exit(1);
  }

  const imagePrompts = (job.metadata?.imagePrompts as string[] | undefined) ?? [];
  const markerCount = imagePrompts.length;
  if (markerCount === 0) {
    console.error(
      `metadata.imagePrompts가 비어 있습니다 - job:write가 아직 안 끝났거나 [IMAGE PROMPT:] 마커가 없는 원고입니다: ${jobId}`
    );
    process.exit(1);
  }

  // slideIndex(1..N, 캐러셀 순서)를 그대로 두되, markerCount를 넘는 인덱스는 버린다.
  const usable = candidates.filter((c) => c.index <= markerCount);
  const dropped = candidates.length - usable.length;
  if (dropped > 0) {
    console.warn(`⚠️ [ig-promote-images] 마커(${markerCount}개)보다 뒤 순번인 후보 ${dropped}개는 버립니다.`);
  }
  if (usable.length < candidates.length - dropped) {
    console.warn(`⚠️ [ig-promote-images] 마커 ${markerCount}개 중 ${usable.length}개 자리만 후보가 있습니다 - 나머지는 뷰어에서 비어 보입니다.`);
  }

  await ArticleJobRepository.mergeMetadata(jobId, { images: usable, imagesReadyAt: new Date().toISOString() });
  console.log(`✅ [ig-promote-images] job ${jobId}: 후보 ${usable.length}장을 metadata.images로 옮겼습니다.`);
}

main().catch((error) => {
  console.error("❌ [ig-promote-images] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
