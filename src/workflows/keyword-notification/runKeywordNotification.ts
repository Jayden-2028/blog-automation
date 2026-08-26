// keyword notification을 실제로 Telegram에 발송하는 ad-hoc entry point.
// "매일 오전 8시" 정기 실행은 jobs/dailyKeywordJob.ts(수집->클러스터링->랭킹->저장->알림 전체)가 담당하고,
// 이 스크립트는 그 중 발송 단계만 다시 실행하고 싶을 때 쓴다 — 예: 알림만 실패해서 재발송하거나,
// 최근 완료된 run 결과를 수동으로 다시 보내고 싶을 때. 새로 수집/랭킹하지 않고 가장 최근에 완료된
// discovery_run을 그대로 조회해서 보낸다.
// 이 워크플로우는 Supabase를 쓰므로 client.ts의 dotenv 로딩에 편승하지만, TelegramNotifier는
// Supabase에 의존하지 않으므로 명시적으로 한 번 더 로드해둔다(다른 test*.ts들과 동일한 관례).
import "dotenv/config";

import { sendKeywordNotification } from "./sendKeywordNotification.js";

async function main() {
  const result = await sendKeywordNotification({ dryRun: false });

  if (result.reason === "no_data") {
    console.log("⚠️ 발송할 keyword_rankings 데이터가 없습니다 (완료된 discovery_run 없음).");
    return;
  }

  console.log(
    `✅ Telegram 발송 완료 (run #${result.payload?.run.id}, 키워드 ${result.payload?.items.length}건, 메시지 ${result.messages.length}건).`
  );
}

main().catch((error) => {
  console.error("❌ Keyword notification 발송 실패:", error.message ?? error);
  process.exit(1);
});
