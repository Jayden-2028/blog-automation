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

import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { LocalScheduler } from "../scheduler/LocalScheduler.js";
import type { SchedulerJob } from "../scheduler/Scheduler.js";
import { runDailyKeywordWorkflow } from "../workflows/dailyKeywordWorkflow.js";

// Creator Advisor 수집(trendCollect)은 enrichment 단계다 - 실패해도 seed_queries만으로 파이프라인이
// 정상 완주하므로 job 전체를 실패로 처리하지 않는다(buildDailyQueryPool.ts의 fallback 설계와 동일).
//
// competition(블로그 경쟁도 프로브)도 같은 이유로 비치명적이다 - 점수/순위/알림에 아무 영향이 없는
// 관측 전용 단계이므로(config/keywordCompetition.ts), 실패했다고 사용자에게 실패 알림을 보내거나
// 이미 만들어진 Top 10 발송을 막으면 안 된다.
const NON_FATAL_STAGES = new Set(["trendCollect", "competition"]);

const job: SchedulerJob = {
  name: "daily-keyword",
  execute: async () => {
    // 오전 09:00 run은 Creator Advisor + 구글 트렌드까지만. 커뮤니티(더쿠)는 오후 13:00
    // communityKeywordJob으로 분리했다(2026-08-31) - 오전/오후 알림이 각각 개별로 온다.
    const result = await runDailyKeywordWorkflow({
      collectionSources: ["creator_advisor", "google_trends"],
    });

    console.log("\n▶ stage log");
    for (const entry of result.stageLog) {
      const detail = entry.error ? ` - ${entry.error}` : "";
      console.log(`   [${entry.stage}] ${entry.status} (${entry.durationMs}ms)${detail}`);
    }

    if (result.trendCollection?.status === "failed") {
      console.log(`\n⚠️ Creator Advisor 수집 실패(비치명적) - ${result.trendCollection.error}`);
    }
    if (result.googleTrendsCollection?.status === "failed") {
      console.log(`\n⚠️ 구글 트렌드 수집 실패(비치명적) - ${result.googleTrendsCollection.error}`);
    }
    if (result.communityCollection?.status === "failed") {
      console.log(`\n⚠️ 커뮤니티 수집 실패(비치명적) - ${result.communityCollection.error}`);
    }
    if (result.communityCollection?.sourceErrors) {
      for (const [site, error] of Object.entries(result.communityCollection.sourceErrors)) {
        console.log(`\n⚠️ 커뮤니티 "${site}" 조회 실패(비치명적, 나머지로 진행) - ${error}`);
      }
    }

    if (result.relevance) {
      console.log(
        `\n▶ relevance filter: ${result.relevance.totalBefore}건 → ${result.relevance.totalAfter}건 ` +
          `(제외 ${result.relevance.droppedCount}건)`
      );
    }

    const failedStage = result.stageLog.find(
      (entry) => entry.status === "failed" && !NON_FATAL_STAGES.has(entry.stage)
    );
    if (failedStage) {
      const message = `"${failedStage.stage}" 단계 실패: ${failedStage.error}`;
      // 지금까지는 실패해도 로그 파일에만 남아서 아무도 몰랐다. 매일 도는 무인 job이므로
      // 알림 없이 조용히 죽는 것을 막는다.
      await notifyPipelineFailure(message, result.stageLog);
      // stageLog에 이미 상세 내용을 남겼으니, LocalScheduler가 프로세스 레벨 실패로도 기록하도록 다시 던진다.
      throw new Error(message);
    }

    if (!result.notification?.sent) {
      const reason = result.notification?.reason ?? "unknown";
      console.log(`\n⚠️ Telegram 미발송 (reason: ${reason})`);
      // dry_run이 아닌데 발송되지 않았다면 사용자가 오늘 키워드를 못 받는다는 뜻이므로 알린다.
      if (reason !== "dry_run") {
        await notifyPipelineFailure(`키워드 알림이 발송되지 않았습니다 (reason: ${reason})`, result.stageLog);
      }
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
