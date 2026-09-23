// 승인된 원고를 맥 로컬 보관함으로 내보낸다(config/manuscriptExport.ts의 경로 규칙).
//
// 맥 로컬 전용이다 - GitHub Actions에는 이 보관함 경로가 없다.
//
// 사용법:
//   npm run manuscript:export                      최근 날짜의 원고 전부
//   npm run manuscript:export -- <jobId>           그 원고만
//   npm run manuscript:export -- --date 2026-09-16 그 날짜 전부
//   npm run manuscript:export -- --all             manifest 전체
//   npm run manuscript:export -- --force           이미 받은 이미지도 다시 받기
import "dotenv/config";

import { MANUSCRIPT_EXPORT_ROOT } from "../../config/manuscriptExport.js";
import { exportManuscript } from "./exportManuscript.js";
import { loadManifest } from "./manuscriptManifest.js";
import type { ManuscriptTopicEntry } from "./manuscriptManifest.js";

function selectTopics(topics: ManuscriptTopicEntry[], args: string[]): ManuscriptTopicEntry[] {
  if (args.includes("--all")) return topics;

  const dateIndex = args.indexOf("--date");
  if (dateIndex >= 0) {
    const date = args[dateIndex + 1];
    if (!date) throw new Error("--date 다음에 날짜(YYYY-MM-DD)가 필요합니다.");
    return topics.filter((t) => t.date === date);
  }

  const jobId = args.find((a) => !a.startsWith("--"));
  if (jobId) return topics.filter((t) => t.jobId === jobId);

  // 기본값: 가장 최근 날짜. loadManifest가 date 내림차순으로 준다.
  const latest = topics[0]?.date;
  return latest ? topics.filter((t) => t.date === latest) : [];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  const manifest = await loadManifest();
  const targets = selectTopics(manifest.topics, args);

  if (targets.length === 0) {
    console.log("내보낼 원고가 없습니다. (npm run manuscript:export -- --all 로 전체를 확인할 수 있습니다)");
    return;
  }

  console.log(`▶ 보관함: ${MANUSCRIPT_EXPORT_ROOT}`);
  console.log(`▶ 원고 ${targets.length}건 내보내는 중...\n`);

  let unfilledTotal = 0;
  let brokenTotal = 0;

  for (const topic of targets) {
    // 한 주제가 던져도 나머지를 계속 내보낸다(2026-09-23 실측 대응).
    //
    // 09-23 내보내기가 "암살자들"에서 ENOENT로 죽으면서 **그 뒤 주제가 전부 안 내려받아졌다**.
    // 원인은 그 주제 하나의 파일명이었는데, 격리가 없어 피해가 나머지로 번졌다. 원고 보관은
    // 건마다 독립이라 한 건의 실패가 다른 건을 막을 이유가 없다.
    let result: Awaited<ReturnType<typeof exportManuscript>>;
    try {
      result = await exportManuscript(topic, { force });
    } catch (error) {
      brokenTotal += 1;
      console.error(`❌ ${topic.date} / ${topic.keyword}`);
      console.error(`   ${error instanceof Error ? error.message : error}`);
      console.error("");
      continue;
    }
    const unfilled = result.slots.filter((s) => s.fileNames.length === 0);
    unfilledTotal += unfilled.length;

    console.log(`✅ ${topic.date} / ${topic.keyword}`);
    console.log(`   ${result.dir}`);
    console.log(`   이미지 ${result.downloaded}장 받음, ${result.skipped}장 건너뜀 · 채울 자리 ${unfilled.length}개`);
    for (const failure of result.failures) console.log(`   ⚠️ ${failure}`);
    for (const slot of unfilled) {
      console.log(`   · [${slot.index}] ${slot.acquisition === "search" ? "웹 검색" : slot.acquisition === "capture" ? "페이지 캡처" : slot.acquisition === "table" ? "표 생성" : "미생성"} — ${slot.description}`);
    }
    console.log("");
  }

  if (brokenTotal > 0) {
    console.log(`⚠️ ${brokenTotal}건은 내보내지 못했습니다(위 ❌). 나머지는 정상 처리했습니다.`);
  }

  if (unfilledTotal > 0) {
    console.log(`채울 자리 ${unfilledTotal}개가 남았습니다. 웹 검색 이미지는 다음으로 채웁니다:`);
    console.log("  npm run images:collect -- <jobId>");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
