// 이미 준비된 원고를 **웹 이미지 수집만 다시** 태우기 위해 게이트를 연다(2026-09-17).
//
// 왜 필요한가: 웹 검색 수집을 파이프라인에 연결한 커밋(91e5896, 09-17 13:53)보다 먼저 준비된
// 원고들은 수집기가 아예 실행되지 않아 `웹 검색` 자리가 전부 비었다(실측 9건 중 5건, 자리 18개).
// 원고·이미지·배리에이션을 다시 만들 필요는 없고 그 자리만 채우면 된다.
//
// 어떤 게이트를 여는가(그리고 무엇을 일부러 열지 않는가):
//   - `channelManuscriptsReadyAt` -> 연다. 이게 있으면 job이 처리 대상에서 빠진다.
//   - `webImagesReadyAt`          -> 연다. 수집 + AI 폴백이 다시 돈다.
//   - `imagesReadyAt`             -> **열지 않는다.** 유료 이미지 생성이 통째로 다시 돈다.
//   - `naverReadyAt`              -> **열지 않는다.** 네이버 배리에이션 LLM이 다시 돈다.
//   - 배리에이션 article row       -> 건드리지 않는다. 있으면 재사용된다(LLM 비용 0).
//
// Blogspot 중복 발행은 publishArticleToBlogspot의 멱등 가드가 막는다(publications에 진행/완료 행이
// 있으면 alreadyDone으로 빠진다) - 확인하고 진행했다.
//
// 사용: npm run manuscripts:reset-web-images -- <jobId 접두사...> [--apply]
// 기본은 미리보기다. --apply 없이는 아무것도 쓰지 않는다.

import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { loadManifest } from "./manuscriptManifest.js";
import { parseImageAcquisition } from "./parseManuscriptBlocks.js";

const IMAGE_MARKER_RE = /^\[IMAGE:\s*([\s\S]*?)\]$/gm;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const prefixes = args.filter((a) => !a.startsWith("--"));

  if (prefixes.length === 0) {
    console.error("사용법: npm run manuscripts:reset-web-images -- <jobId 접두사...> [--apply]");
    process.exitCode = 1;
    return;
  }

  const manifest = await loadManifest();
  const targets = manifest.topics.filter((t) => prefixes.some((p) => t.jobId.startsWith(p)));

  const missing = prefixes.filter((p) => !targets.some((t) => t.jobId.startsWith(p)));
  if (missing.length > 0) {
    console.error(`❌ 찾지 못한 jobId: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(apply ? "▶ 게이트를 엽니다(실제 쓰기)\n" : "▶ 미리보기 - 쓰지 않습니다(--apply로 실행)\n");

  for (const topic of targets) {
    const body = topic.manuscript.body;
    const acquisitions = [...body.matchAll(IMAGE_MARKER_RE)].map((m) => parseImageAcquisition(m[1].trim()));
    // 웹에서 온 이미지(sourcePage)만 채워진 것으로 본다 - AI 폴백으로 메운 자리는 다시 찾는다(C안 전환 후 재수집).
    const filled = new Set(topic.manuscript.images.filter((i) => i.url && i.sourcePage).map((i) => i.index));
    const emptySearch = acquisitions
      .map((acq, i) => ({ acq, index: i + 1 }))
      .filter(({ acq, index }) => acq === "search" && !filled.has(index));

    console.log(`- ${topic.keyword}`);
    console.log(`  job ${topic.jobId} | 마커 ${acquisitions.length} | 웹 사진 없는 자리 ${emptySearch.length}개` +
      (emptySearch.length > 0 ? ` (${emptySearch.map((s) => s.index).join(", ")})` : ""));

    if (emptySearch.length === 0) {
      console.log("  → 채울 자리가 없어 건너뜁니다.");
      continue;
    }

    if (apply) {
      await ArticleJobRepository.mergeMetadata(topic.jobId, {
        channelManuscriptsReadyAt: null,
        webImagesReadyAt: null,
      });
      console.log("  → 게이트를 열었습니다. 다음 job-publish-prepare 실행에서 수집됩니다.");
    }
  }

  if (!apply) console.log("\n확인 후 --apply를 붙여 다시 실행하세요.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
