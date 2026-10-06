// 사용설명서 트랙(The Korea Manual) 주제 제안 - 매일 KST 21:00(Worker cron UTC 12시), **사용설명서 봇(@KoreanManualBot)**으로 발송.
//
// 개편3 §4.2: 시의성 소스가 아니라 영문 검색 수요(자동완성)에서 에버그린 주제 5~10건을 뽑아 Go/Pass로 제안한다.
// Go 이후(research -> write)는 기존 파이프라인 그대로이고, 한글 원고 승인 뒤 영어 번역·재승인·Blogger 발행이 이어진다
// (workflows/translation/*).
import "dotenv/config";

import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { LocalScheduler } from "../scheduler/LocalScheduler.js";
import type { SchedulerJob } from "../scheduler/Scheduler.js";
import { runKsceneTopicCollection } from "../workflows/kscene/runKsceneTopicCollection.js";

const dryRun = process.argv.includes("--dry-run");

const job: SchedulerJob = {
  name: "kscene-topic",
  execute: async () => {
    const result = await runKsceneTopicCollection({ dryRun });

    console.log(`\n▶ 시드 ${result.seedsUsed.length}개 · 제안 ${result.suggestionCount}건 · 후보 ${result.candidateCount}건 · 중복 제외 ${result.droppedAsDuplicate}건`);
    if (result.trendSeeds.length > 0) console.log(`   급상승 시드: ${result.trendSeeds.join(", ")}`);
    if (result.failedSeeds.length > 0) console.log(`   ⚠️ 자동완성 실패 시드: ${result.failedSeeds.join(", ")}`);
    for (const [index, topic] of result.topics.entries()) console.log(`   ${index + 1}. ${topic}`);

    if (result.status === "dry_run") {
      console.log("\n(dry-run: 저장·발송하지 않음)");
      return;
    }
    if (result.status !== "notified") {
      const message = `사용설명서 주제 수집 실패 (${result.status}): ${result.error ?? "원인 미상"}`;
      // 무인 job이라 로그만 남기면 아무도 모른다 - 알리고, 비정상 종료로 watchdog 판정(run 없음)과 일치시킨다.
      await notifyPipelineFailure(message, []);
      throw new Error(message);
    }
    console.log(`\n✅ 완료 — run #${result.runId}, 주제 ${result.topics.length}건 Telegram 발송`);
  },
};

new LocalScheduler().run(job).catch(() => {
  process.exit(1);
});
