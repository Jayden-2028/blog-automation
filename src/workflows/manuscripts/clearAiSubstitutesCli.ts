// `웹 검색` 자리에 들어간 AI 대체 이미지를 지운다(2026-09-18 사용자 결정).
//
// 왜(사용자 반려): 첫 백필 때는 "빈 자리보다 AI 이미지가 낫다"는 방침으로 웹 검색 실패 자리를 AI로
// 메웠다. 그 결과 "포스터" 캡션 밑에 생성 이미지가 붙고, 여성 감독이 남자로 그려져 사용자가 전부
// 반려했다. 지금 규칙(buildFallbackImagePrompts)은 실물 특정 자리면 AI를 만들지 않지만, 규칙이 바뀌기
// **전에 만들어진 이미지는 그대로 남아 있다** - 그걸 여기서 걷어낸다.
//
// 판정 기준은 하나다: **마커가 `웹 검색`인데 이미지에 sourcePage가 없다**. sourcePage는 웹에서
// 가져온 이미지에만 붙으므로(collectWebImagesForJob), 없으면 AI로 만든 것이다. `AI 생성`·`표 생성`
// 자리는 손대지 않는다.
//
// 지우면 뷰어가 그 자리를 "이미지 미생성 - 아래 프롬프트로 직접 만들어 이 자리에 넣으세요"로
// 표시하므로, 사람이 직접 채울 수 있다.
//
// 두 곳을 같이 지운다. 한 곳만 지우면 다음 실행이 다른 쪽에서 복구해 되살아난다:
//   - manuscript_manifest_topics.channels[0].images (뷰어가 읽는다)
//   - article_jobs.metadata.images                  (prepareManuscript가 재사용한다)
//
// 사용: npm run manuscripts:clear-ai-substitutes -- <jobId 접두사...> [--apply]
// 기본은 미리보기다. --apply 없이는 아무것도 쓰지 않는다.

import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { loadManifest, saveManifest, upsertTopicEntry } from "./manuscriptManifest.js";
import type { ManuscriptImage, ManuscriptManifest } from "./manuscriptManifest.js";
import { parseImageAcquisition } from "./parseManuscriptBlocks.js";

const IMAGE_MARKER_RE = /^\[IMAGE:\s*([\s\S]*?)\]$/gm;

/** 마커가 `웹 검색`인데 sourcePage가 없는 이미지의 자리 번호. */
function findAiSubstitutes(body: string, images: ManuscriptImage[]): number[] {
  const acquisitions = [...body.matchAll(IMAGE_MARKER_RE)].map((m) => parseImageAcquisition(m[1].trim()));
  return images
    .filter((image) => {
      const acquisition = acquisitions[image.index - 1];
      return acquisition === "search" && !image.sourcePage;
    })
    .map((image) => image.index)
    .sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const prefixes = args.filter((a) => !a.startsWith("--"));

  if (prefixes.length === 0) {
    console.error("사용법: npm run manuscripts:clear-ai-substitutes -- <jobId 접두사...> [--apply]");
    process.exitCode = 1;
    return;
  }

  let manifest = await loadManifest();
  const targets = manifest.topics.filter((t) => prefixes.some((p) => t.jobId.startsWith(p)));

  const missing = prefixes.filter((p) => !targets.some((t) => t.jobId.startsWith(p)));
  if (missing.length > 0) {
    console.error(`❌ 찾지 못한 jobId: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(apply ? "▶ AI 대체 이미지를 지웁니다(실제 쓰기)\n" : "▶ 미리보기 - 쓰지 않습니다(--apply로 실행)\n");

  let changed = 0;
  for (const topic of targets) {
    const images = topic.manuscript.images ?? [];
    const doomed = findAiSubstitutes(topic.manuscript.body, images);

    console.log(`- ${topic.keyword}`);
    if (doomed.length === 0) {
      console.log(`  job ${topic.jobId} | 지울 AI 대체 이미지 없음`);
      continue;
    }
    for (const index of doomed) {
      const image = images.find((i) => i.index === index);
      console.log(`  [자리 ${index}] ${image?.description ?? ""}`);
    }

    if (!apply) continue;

    const kept = images.filter((i) => !doomed.includes(i.index));
    manifest = upsertTopicEntry(manifest, {
      ...topic,
      manuscript: { ...topic.manuscript, images: kept },
    });
    // job.metadata.images도 같이 지운다 - 안 지우면 prepareManuscript가 재실행 때 되살린다.
    await ArticleJobRepository.mergeMetadata(topic.jobId, { images: kept });
    changed += 1;
    console.log(`  → ${doomed.length}장을 지웠습니다(뷰어는 "직접 만들어 넣으세요"로 표시합니다).`);
  }

  if (apply && changed > 0) {
    await saveManifest(manifest satisfies ManuscriptManifest);
    console.log(`\n✅ ${changed}건 저장 완료. 뷰어에 반영하려면 manuscripts-refresh를 실행하세요.`);
  } else if (!apply) {
    console.log("\n확인 후 --apply를 붙여 다시 실행하세요.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
