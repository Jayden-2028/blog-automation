// 19:00 KST "오늘의 핫이슈 스타 Top 5" 알림 job(KEYWORD-REFRESH-2026-10.md §B).
// Worker cron 10 UTC 슬롯 -> entertainment-hot-star.yml -> 이 스크립트.
//
// 이 job 자체는 파이프라인(research/write)을 건드리지 않는다. 알림에 붙는 인물별 `✍️ 인물글` 버튼(pgo:)을 누를 때
// 비로소 telegram-update 경로가 category=person job을 만든다(인물 백과 트랙, 2026-10-13).
// 실패해도 다른 트랙에 영향이 없으므로 notifyPipelineFailure를 부르지 않고 종료 코드로만 알린다
// (실패는 GitHub Actions의 빨간 run과 discovery_runs 미기록으로 드러난다).
import "dotenv/config";

import { runHotStarCollection } from "../workflows/hot-star/runHotStarCollection.js";

const dryRun = process.argv.includes("--dry-run");

runHotStarCollection({ dryRun })
  .then((result) => {
    console.log(
      `▶ 재료 ${result.materialCount}건(랭킹 ${result.rankingMaterialCount} · 트렌드 ${result.trendMaterialCount})` +
        `${result.eveningRunId ? `, 엔터 run #${result.eveningRunId}` : ", 엔터 run 없음"}`
    );
    for (const person of result.people) {
      console.log(`   ${person.rank}. ${person.name}${person.alsoInEveningNotification ? " (18시 알림 중복)" : ""} - ${person.background}`);
    }
    if (result.saveError) console.warn(`⚠️ run 기록 실패: ${result.saveError}`);

    switch (result.status) {
      case "notified":
        console.log(`✅ 완료 — run #${result.runId}, 인물 ${result.people.length}명 Telegram 발송, 인물글 버튼 ${result.buttonLabels?.length ?? 0}개`);
        return;
      case "dry_run":
        console.log(`\n${result.message ?? ""}\n`);
        console.log(`버튼(인물글 ${result.buttonLabels?.length ?? 0}개): ${(result.buttonLabels ?? []).join(" | ")}`);
        console.log(`✅ dry-run — 인물 ${result.people.length}명 (발송하지 않음)`);
        return;
      default:
        console.error(`❌ ${result.status}: ${result.error ?? "원인 불명"}`);
        process.exit(1);
    }
  })
  .catch((error) => {
    console.error("❌ [hot-star] 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
