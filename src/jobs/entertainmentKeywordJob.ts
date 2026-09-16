// "매일 오전 9시 10분 실행"의 실제 진입점 - 연예 가십 + 영화·드라마·예능·OTT 카테고리, 블로그스팟용.
// 외부 OS crontab/launchd가 이 스크립트를 하루 1회 실행시킨다(scheduler/LocalScheduler.ts 주석 참고).
//
// 2026-09-07 채널 전담제 개편(사용자 결정) - socialIssueKeywordJob.ts와 짝을 이루는 job이다. 그
// job이 09:00에 이미 Creator Advisor 크롤링 + 구글 트렌드 + 다음 실시간 트렌드 조회를 끝내고
// trend_candidates에 오늘자 후보를 채워 두므로, 이 job은 **재수집을 하지 않는다**
// (trendCollectOptions/googleTrendsOptions/daumRealtimeOptions를 enabled:false로 꺼서 소스
// 재조회를 건너뜀) - Creator Advisor 브라우저 자동화를 하루 두 번 돌리는 건 로그인 세션·rate limit
// 부담만 키운다. 대신 collectionSources에는 세 소스 이름을 그대로 남겨 buildDailyQueryPool()이
// 오늘자 trend_candidates를 읽게 하고, includeCategories로 연예·OTT만 추려 별도의 Top N + Telegram
// 알림을 만든다. 그래서 이 job은 **반드시 socialIssueKeywordJob 이후에 실행돼야 한다**(launchd
// 09:00 / 09:10 순서로 보장).
import "dotenv/config";

import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { LocalScheduler } from "../scheduler/LocalScheduler.js";
import type { SchedulerJob } from "../scheduler/Scheduler.js";
import { runDailyKeywordWorkflow } from "../workflows/dailyKeywordWorkflow.js";

const NON_FATAL_STAGES = new Set(["trendCollect", "competition"]);

// 2026-09-16 사용자 요청: 알림 문구에서 매체명을 뺀다 - socialIssueKeywordJob.ts 참고.
const NOTIFICATION_HEADER = "🎬 <b>오전 연예 OTT 키워드</b>";

const job: SchedulerJob = {
  name: "entertainment-keyword",
  execute: async () => {
    const result = await runDailyKeywordWorkflow({
      collectionSources: ["creator_advisor", "google_trends", "daum_realtime"],
      // 크롤링은 socialIssueKeywordJob이 이미 했다 - 여기서는 재수집하지 않고 오늘자
      // trend_candidates를 그대로 읽는다(buildDailyQueryPool은 collectionSources만 본다).
      trendCollectOptions: { enabled: false },
      googleTrendsOptions: { enabled: false },
      daumRealtimeOptions: { enabled: false },
      includeCategories: ["entertainment", "ott"],
      metadata: { kind: "entertainment" },
      notifyOptions: { headerTitle: NOTIFICATION_HEADER },
    });

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

    const failedStage = result.stageLog.find(
      (entry) => entry.status === "failed" && !NON_FATAL_STAGES.has(entry.stage)
    );
    if (failedStage) {
      const message = `"${failedStage.stage}" 단계 실패: ${failedStage.error}`;
      await notifyPipelineFailure(message, result.stageLog);
      throw new Error(message);
    }

    if (!result.notification?.sent) {
      const reason = result.notification?.reason ?? "unknown";
      console.log(`\n⚠️ Telegram 미발송 (reason: ${reason})`);
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
