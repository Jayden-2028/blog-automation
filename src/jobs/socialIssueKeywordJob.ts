// 사회 이슈 트랙 데일리 리포트 - 매일 KST 20:00(Worker cron, UTC 11시), **사회 봇(@JaydensocialnewsBot)**으로 발송.
//
// 2026-10-05 개편(RESTRUCTURE-PLAN-2026-10.md §3.2): 키워드 목록 제안형이다. 그날의 사건사고·정책·경제·
// 커뮤니티 화제 키워드를 섹션별로 묶어 한 번에 보내고, 사용자가 Go를 누른 건만 원고를 쓴다. 원고가 끝나도
// **자동 발행은 없다** - 뷰어(social.html)에서 복사해 티스토리에 수동 발행한다.
//
// 수집 비용을 늘리지 않는다: 커뮤니티(더쿠·루리웹·에펨코리아)는 엔터 회차 3번이 낮 동안 이미
// trend_candidates에 채워 뒀다. 여기서는 다시 크롤링하지 않고(communityOptions.enabled=false) 그 값을 읽어
// 사회 계열 분류(incident/living/community)만 수거한다. 엔터·OTT로 분류된 것은 엔터 알림이 이미 가져갔다.
//
// (이전: 2026-09-07 채널 전담제에서 이 job이 수집 전담이었고 엔터 job이 결과를 재사용했다. 2026-10-05
// 개편1에서 엔터가 자체 수집으로 독립해 그 의존은 사라졌다.)
import "dotenv/config";

import { formatSocialReportHeader, isEntertainmentLeak, SOCIAL_REPORT_SECTION_CONFIG } from "../config/socialReportSections.js";
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
  name: "social-issue-keyword",
  execute: async () => {
    const result = await runDailyKeywordWorkflow({
      // community는 수집 목록에 두되 크롤링은 끈다 - 엔터 회차가 채워 둔 오늘치를 읽기만 한다(위 머리말).
      collectionSources: ["creator_advisor", "google_trends", "daum_realtime", "community"],
      communityOptions: { enabled: false },
      // community category = 인터넷 화제·논쟁(keywordCategoryRules). 사회 계열 커뮤니티 키워드가 여기 속한다.
      includeCategories: ["incident", "living", "community"],
      // 엔터를 뺀 뒤에도 10건이 되도록 20위까지 저장해 둔다(알림에서 isEntertainmentLeak로 거른다).
      rankOptions: { topN: 20 },
      metadata: { kind: "social_issue", track: "social" },
      notifyOptions: {
        track: "social",
        headerTitle: formatSocialReportHeader(),
        sections: SOCIAL_REPORT_SECTION_CONFIG,
        excludeItem: isEntertainmentLeak,
        topN: 10,
      },
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
