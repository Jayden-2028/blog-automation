// "매일 오전 8시 실행"의 실제 진입점. 외부 OS crontab/launchd가 이 스크립트를 하루 1회 실행시킨다
// (scheduler/LocalScheduler.ts 주석 참고 — 이 프로세스 자체는 시간을 감시하지 않는다).
//
// crontab 등록 예시(로컬 타임존 기준 매일 08:00, 결과는 logs/daily-keyword.log에 append):
//
//   0 8 * * * cd /path/to/blog-automation && /usr/local/bin/npm run job:daily-keyword >> logs/daily-keyword.log 2>&1
//
// macOS에서 launchd를 쓰려면 crontab 대신 ~/Library/LaunchAgents에 동일한 커맨드 +
// <key>StartCalendarInterval</key> Hour=8/Minute=0 을 담은 .plist를 등록하면 된다.
import "dotenv/config";

import { LocalScheduler } from "../scheduler/LocalScheduler.js";
import type { SchedulerJob } from "../scheduler/Scheduler.js";
import { runDailyKeywordWorkflow } from "../workflows/dailyKeywordWorkflow.js";

const job: SchedulerJob = {
  name: "daily-keyword",
  execute: async () => {
    const result = await runDailyKeywordWorkflow();

    console.log("\n▶ stage log");
    for (const entry of result.stageLog) {
      const detail = entry.error ? ` - ${entry.error}` : "";
      console.log(`   [${entry.stage}] ${entry.status} (${entry.durationMs}ms)${detail}`);
    }

    if (result.relevance) {
      console.log(
        `\n▶ relevance filter: ${result.relevance.totalBefore}건 → ${result.relevance.totalAfter}건 ` +
          `(제외 ${result.relevance.droppedCount}건)`
      );
    }

    const failedStage = result.stageLog.find((entry) => entry.status === "failed");
    if (failedStage) {
      // stageLog에 이미 상세 내용을 남겼으니, LocalScheduler가 프로세스 레벨 실패로도 기록하도록 다시 던진다.
      throw new Error(`"${failedStage.stage}" 단계 실패: ${failedStage.error}`);
    }

    if (!result.notification?.sent) {
      console.log(`\n⚠️ Telegram 미발송 (reason: ${result.notification?.reason ?? "unknown"})`);
      return;
    }

    console.log(
      `\n✅ 완료 — run #${result.saved?.runId}, 키워드 ${result.notification.payload?.items.length}건 Telegram 발송`
    );
  },
};

new LocalScheduler().run(job).catch(() => {
  process.exit(1);
});
