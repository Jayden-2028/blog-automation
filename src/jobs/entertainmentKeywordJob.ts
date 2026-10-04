// 엔터 트랙 키워드 수집 job - 연예 가십 + 영화·드라마·예능·OTT 카테고리.
//
// 2026-10-05 개편(RESTRUCTURE-PLAN-2026-10.md §2.2): **자체 수집으로 독립했다.** 전에는 social job이
// 먼저 trend_candidates를 채워 두면 이 job이 읽기만 했다(social 18:00 -> ent 19:00 순서 의존). 엔터가
// 하루 3회(KST 09/13/18시) social과 무관하게 먼저 도므로 구글 트렌드·다음 실시간을 직접 수집한다.
// 회차(오전/오후/저녁)는 KEYWORD_ROUND 또는 실행 시각으로 정해져 알림 제목과 run metadata에 남는다
// (config/keywordRound.ts).
//
// Creator Advisor만은 여기서 크롤링하지 않는다 - 로그인된 브라우저 프로필이 필요해 클라우드에서
// 못 돌고, 맥미니 폴러가 따로 trend_candidates에 넣는다. collectionSources에는 남겨 두어 그 값을
// 읽어 쓴다(buildDailyQueryPool은 collectionSources만 본다). 회차마다 CA 신선도가 다르다는 점은
// 설계서 §2.3 참고.
import "dotenv/config";

import { formatEntertainmentHeader, resolveKeywordRound } from "../config/keywordRound.js";
import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { LocalScheduler } from "../scheduler/LocalScheduler.js";
import type { SchedulerJob } from "../scheduler/Scheduler.js";
import { runDailyKeywordWorkflow } from "../workflows/dailyKeywordWorkflow.js";

const NON_FATAL_STAGES = new Set(["trendCollect", "competition"]);

const job: SchedulerJob = {
  name: "entertainment-keyword",
  execute: async () => {
    const round = resolveKeywordRound();
    console.log(`▶ 엔터 키워드 수집 - ${round.label}`);

    const result = await runDailyKeywordWorkflow({
      collectionSources: ["creator_advisor", "google_trends", "daum_realtime"],
      // CA는 크롤링하지 않고 맥미니가 넣어 둔 값을 읽기만 한다. 구글·다음은 기본값(켜짐)으로 직접 수집한다.
      trendCollectOptions: { enabled: false },
      includeCategories: ["entertainment", "ott"],
      metadata: { kind: "entertainment", round: round.round },
      notifyOptions: { headerTitle: formatEntertainmentHeader(round) },
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
