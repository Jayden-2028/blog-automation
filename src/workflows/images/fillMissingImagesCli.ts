// 이미 준비된 원고에서 **아직 비어 있는 `AI 생성` 자리만** 채운다(맥 로컬 전용).
//
// 왜 필요한가(2026-09-17): prepareManuscript의 이미지 생성은 job당 1회다
// (`metadata.imagesReadyAt`으로 멱등 처리). 그래서 나중에 마커를 고치거나(images:refix) 생성이
// 실패한 자리가 생겨도 자동으로는 다시 만들지 않는다. 이 CLI가 그 빈 자리만 메운다.
//
// **유료 호출이다.** 기본은 미리보기이고 `--apply`를 붙여야 실제로 만든다. 켜는 값도 명시적으로
// 넘겨야 한다 - 파이프라인은 GitHub variables에서 읽지만 로컬 .env에는 없다:
//   MANUSCRIPT_IMAGE_GENERATION=true IMAGE_AB_COMPARE=false IMAGE_PROVIDER=openai \
//     npm run images:fill -- <jobId> --apply
import "dotenv/config";

import { MANUSCRIPT_IMAGE_CONFIG } from "../../config/manuscriptImages.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { exportManuscript } from "../manuscripts/exportManuscript.js";
import { loadManifest, readJobManuscriptImages, saveManifest } from "../manuscripts/manuscriptManifest.js";
import type { ManuscriptImage, ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { generateManuscriptImages } from "./generateManuscriptImages.js";

function selectTopics(topics: ManuscriptTopicEntry[], args: string[]): ManuscriptTopicEntry[] {
  const dateIndex = args.indexOf("--date");
  if (dateIndex >= 0) {
    const date = args[dateIndex + 1];
    if (!date) throw new Error("--date 다음에 날짜(YYYY-MM-DD)가 필요합니다.");
    return topics.filter((t) => t.date === date);
  }
  const jobId = args.find((a) => !a.startsWith("--"));
  if (!jobId) throw new Error("사용법: npm run images:fill -- <jobId> [--apply] (또는 --date YYYY-MM-DD)");
  return topics.filter((t) => t.jobId === jobId);
}

/** 채워야 할 자리: `AI 생성` 마커인데 url 있는 이미지가 아직 없는 번호. */
function missingAiSlots(topic: ManuscriptTopicEntry, existing: ManuscriptImage[]): { index: number; description: string }[] {
  const blocks = parseManuscriptBlocks(topic.manuscript.body, topic.manuscript.imagePrompts).filter(
    (b) => b.type === "image"
  );
  const filled = new Set(existing.filter((i) => i.url).map((i) => i.index));

  return blocks
    .map((block, i) => ({ block, index: i + 1 }))
    .filter(({ block }) => block.type === "image" && block.acquisition === "ai")
    .filter(({ index }) => !filled.has(index))
    .map(({ block, index }) => ({ index, description: block.type === "image" ? block.description : "" }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const manifest = await loadManifest();
  const targets = selectTopics(manifest.topics, args);
  if (targets.length === 0) {
    console.log("해당하는 원고를 manifest에서 찾지 못했습니다.");
    return;
  }

  if (apply && !MANUSCRIPT_IMAGE_CONFIG.enabled) {
    console.log(
      "MANUSCRIPT_IMAGE_GENERATION이 켜져 있지 않아 생성하지 않습니다(유료 호출 가드).\n" +
        "  MANUSCRIPT_IMAGE_GENERATION=true IMAGE_AB_COMPARE=false IMAGE_PROVIDER=openai npm run images:fill -- <jobId> --apply"
    );
    return;
  }

  console.log(apply ? "▶ 모드: 실제 생성(--apply · 유료 호출)\n" : "▶ 모드: 미리보기 (실제로 만들려면 --apply)\n");

  let plannedTotal = 0;

  for (const topic of targets) {
    const existing = await ArticleJobRepository.findById(topic.jobId).then((job) =>
      job ? readJobManuscriptImages(job) : []
    );
    const missing = missingAiSlots(topic, existing);

    console.log(`▶ ${topic.date} / ${topic.keyword}`);
    if (missing.length === 0) {
      console.log("   빈 AI 생성 자리가 없습니다.\n");
      continue;
    }

    for (const slot of missing) console.log(`   [자리 ${slot.index}] ${slot.description}`);
    plannedTotal += missing.length;

    if (!apply) {
      console.log("");
      continue;
    }

    const outcome = await generateManuscriptImages(
      {
        jobId: topic.jobId,
        keyword: topic.keyword,
        date: topic.date,
        body: topic.manuscript.body,
        imagePrompts: topic.manuscript.imagePrompts,
      },
      { onlyIndexes: missing.map((s) => s.index) }
    );

    for (const failure of outcome.failures) console.log(`   ⚠️ ${failure}`);
    const made = outcome.images.filter((i) => i.url);
    if (made.length === 0) {
      console.log("   만들어진 이미지가 없습니다.\n");
      continue;
    }

    // 기존 이미지와 합친다 - 이번에 만든 자리만 갈아끼우고 나머지는 그대로 둔다.
    const merged = [...existing.filter((e) => !outcome.images.some((n) => n.index === e.index)), ...outcome.images].sort(
      (a, b) => a.index - b.index
    );
    await ArticleJobRepository.mergeMetadata(topic.jobId, { images: merged });

    const updated: ManuscriptTopicEntry = { ...topic, manuscript: { ...topic.manuscript, images: merged } };
    await saveManifest({ topics: [updated] });
    await exportManuscript(updated);

    for (const image of made) console.log(`   ✅ [${image.index}] ${image.fileName}`);
    console.log(`   반영 완료(job.metadata·manifest) + 보관함 갱신\n`);
  }

  if (!apply && plannedTotal > 0) {
    console.log(`총 ${plannedTotal}자리를 만들 수 있습니다(유료). 실행하려면:`);
    console.log("  MANUSCRIPT_IMAGE_GENERATION=true IMAGE_AB_COMPARE=false IMAGE_PROVIDER=openai npm run images:fill -- <인자> --apply");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
