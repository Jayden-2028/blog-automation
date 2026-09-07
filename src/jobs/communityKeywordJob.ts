// "매일 오후 1시 실행"의 진입점 - 커뮤니티 화제 카테고리(하루 3개 고정 알림 중 세 번째,
// 2026-09-07 채널 전담제 개편). 오전의 socialIssueKeywordJob(09:00, 티스토리용)/
// entertainmentKeywordJob(09:10, 블로그스팟용)와 별개로, 커뮤니티(더쿠 인기글) 유래 키워드만
// 모아 별도 알림 1건을 더 보낸다(2026-08-31 사용자 결정).
//
// 오전 job들과 같은 파이프라인을 그대로 태운다(collect → relevance → cluster → rank → notify) -
// 커뮤니티 키워드도 NAVER 검색으로 볼륨/경쟁도를 보강하고 관련성 필터를 거쳐야 발행 가치를
// 판별할 수 있다. 다른 점은 세 가지뿐이다:
//   1. collectionSources = ["community"]      - 커뮤니티 수집기만 돌리고, 그 source만 pool에 읽는다
//   2. includeSeedQueries = false             - 오전 seed를 다시 태우지 않는다
//   3. notifyOptions.headerTitle / metadata.kind = "community"  - 알림·조회에서 오전 run들과 구분
//
// launchd 등록: ~/Library/LaunchAgents/com.wooahpapa.blog-automation.community-keyword.plist
//   StartCalendarInterval Hour=13 Minute=0, caffeinate -i 래핑, WorkingDirectory = 운영 worktree.
import "dotenv/config";

import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { LocalScheduler } from "../scheduler/LocalScheduler.js";
import type { SchedulerJob } from "../scheduler/Scheduler.js";
import { runDailyKeywordWorkflow } from "../workflows/dailyKeywordWorkflow.js";

// 커뮤니티 수집(trendCollect)은 enrichment 단계다 - 실패해도 job 전체를 실패로 처리하지 않는다
// (오전 job들과 동일). 단 오후 job은 커뮤니티가 유일한 소스라, 수집이 완전히 실패하면
// 아래 "candidatesCount 0" 경로에서 알림이 나간다.
// competition(블로그 경쟁도 프로브)은 관측 전용이라 실패해도 job을 실패시키지 않는다
// (오전 job들과 동일 - config/keywordCompetition.ts 참고).
const NON_FATAL_STAGES = new Set(["trendCollect", "competition"]);

const NOTIFICATION_HEADER = "📡 <b>오후 커뮤니티 인기 키워드</b>";

const job: SchedulerJob = {
  name: "community-keyword",
  execute: async () => {
    const result = await runDailyKeywordWorkflow({
      collectionSources: ["community"],
      includeSeedQueries: false,
      metadata: { kind: "community" },
      notifyOptions: { headerTitle: NOTIFICATION_HEADER },
    });

    console.log("\n▶ stage log");
    for (const entry of result.stageLog) {
      const detail = entry.error ? ` - ${entry.error}` : "";
      console.log(`   [${entry.stage}] ${entry.status} (${entry.durationMs}ms)${detail}`);
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
      const message = `[community] "${failedStage.stage}" 단계 실패: ${failedStage.error}`;
      await notifyPipelineFailure(message, result.stageLog);
      throw new Error(message);
    }

    if (!result.notification?.sent) {
      const reason = result.notification?.reason ?? "unknown";
      console.log(`\n⚠️ Telegram 미발송 (reason: ${reason})`);
      // no_data는 오늘 커뮤니티에서 건질 키워드가 없었다는 뜻 - 오전 알림은 이미 갔으므로
      // 치명적이지는 않지만, 계속 반복되면 커뮤니티 수집기가 죽은 것이므로 알린다.
      if (reason !== "dry_run") {
        await notifyPipelineFailure(
          `오후 커뮤니티 키워드 알림이 발송되지 않았습니다 (reason: ${reason})`,
          result.stageLog
        );
      }
      return;
    }

    console.log(
      `\n✅ 완료 — run #${result.saved?.runId}, 커뮤니티 키워드 ${result.notification.payload?.items.length}건 Telegram 발송`
    );
  },
};

new LocalScheduler().run(job).catch(() => {
  process.exit(1);
});
