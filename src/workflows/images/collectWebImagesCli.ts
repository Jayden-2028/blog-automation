// 원고의 `웹 검색` 이미지 자리를 Codex로 채운다(맥 로컬 전용 - codex CLI가 필요하다).
//
// 먼저 `npm run manuscript:export`로 보관함 폴더를 만든 뒤에 돌린다. 이 명령은 그 폴더에
// 이미지 파일과 web-images.json을 채우고, 마지막에 내보내기를 다시 돌려 image-metadata.md를
// 완전한 상태로 다시 쓴다.
//
// 사용법:
//   npm run images:collect -- <jobId>
//   npm run images:collect -- --date 2026-09-16
import "dotenv/config";

import { collectWebImages, buildWebImageSlots } from "./collectWebImages.js";
import { exportManuscript } from "../manuscripts/exportManuscript.js";
import { loadManifest } from "../manuscripts/manuscriptManifest.js";
import type { ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";

function selectTopics(topics: ManuscriptTopicEntry[], args: string[]): ManuscriptTopicEntry[] {
  const dateIndex = args.indexOf("--date");
  if (dateIndex >= 0) {
    const date = args[dateIndex + 1];
    if (!date) throw new Error("--date 다음에 날짜(YYYY-MM-DD)가 필요합니다.");
    return topics.filter((t) => t.date === date);
  }

  const jobId = args.find((a) => !a.startsWith("--"));
  if (!jobId) throw new Error("사용법: npm run images:collect -- <jobId> (또는 --date YYYY-MM-DD)");
  return topics.filter((t) => t.jobId === jobId);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifest = await loadManifest();
  const targets = selectTopics(manifest.topics, args);

  if (targets.length === 0) {
    console.log("해당하는 원고를 manifest에서 찾지 못했습니다.");
    return;
  }

  for (const topic of targets) {
    const slots = buildWebImageSlots(topic.manuscript.body, topic.manuscript.imagePrompts);

    console.log(`\n▶ ${topic.date} / ${topic.keyword}`);
    if (slots.length === 0) {
      console.log("   웹 검색 자리가 없습니다.");
      continue;
    }

    // 폴더가 없을 수 있으므로(내보내기를 아직 안 돌린 경우) 먼저 한 번 내보낸다.
    const exported = await exportManuscript(topic);
    console.log(`   보관함: ${exported.dir}`);
    console.log(`   웹 검색 자리 ${slots.length}개 - Codex로 찾는 중(수 분 걸립니다)...`);

    const result = await collectWebImages({ keyword: topic.keyword, dir: exported.dir, slots });

    for (const image of result.found) {
      console.log(`   ✅ [${image.index}] ${image.fileName}`);
      console.log(`      출처: ${image.sourcePage} (${image.license})`);
    }
    for (const failure of result.failures) console.log(`   ⚠️ ${failure}`);

    if (result.found.length > 0) {
      // 찾은 이미지를 image-metadata.md에 반영한다(내보내기가 web-images.json을 읽는다).
      await exportManuscript(topic);
      console.log(`   image-metadata.md 갱신 완료 (${result.found.length}장 추가)`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
