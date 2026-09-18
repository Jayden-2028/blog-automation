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

  for (const topic of targets) {
    const result = await exportManuscript(topic, { force });
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

  if (unfilledTotal > 0) {
    console.log(`채울 자리 ${unfilledTotal}개가 남았습니다. 웹 검색 이미지는 다음으로 채웁니다:`);
    console.log("  npm run images:collect -- <jobId>");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
