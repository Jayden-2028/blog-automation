// keyword notification 파이프라인 테스트.
// 기본은 dry-run이다 — 실제 Telegram으로 발송하지 않고, 발송될 메시지 내용을 콘솔에 그대로 출력해
// (a) 최근 완료된 discovery_run의 keyword_rankings TOP N이 잘 조회되는지,
// (b) score breakdown이 메시지에 포함되는지,
// (c) 추천 제목 placeholder 3개가 항목마다 붙는지,
// (d) 메시지가 chunk로 잘 나뉘는지
// 를 눈으로 확인할 수 있게 한다.
//
// 실제 발송까지 검증하려면(=Telegram 채팅방에 진짜 메시지가 감), TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID를
// .env에 채운 뒤 `SEND=1 npm run test:notification`으로 실행한다. 기본값(SEND 미설정)은 항상 dry-run.
import "dotenv/config";

import { sendKeywordNotification } from "./sendKeywordNotification.js";

const shouldActuallySend = process.env.SEND === "1";

async function main() {
  console.log("▶ Keyword Notification 테스트 시작");
  console.log(`모드: ${shouldActuallySend ? "실제 발송(SEND=1)" : "dry-run(기본값, 발송 안 함)"}`);

  const result = await sendKeywordNotification({ dryRun: !shouldActuallySend });

  if (result.reason === "no_data") {
    console.log("\n⚠️ 발송할 keyword_rankings 데이터가 없습니다 (완료된 discovery_run 없음).");
    console.log("   먼저 npm run test:ranking으로 ranking history를 한 번 생성해주세요.");
    return;
  }

  console.log(`\n▶ 대상 run: #${result.payload?.run.id} (started_at: ${result.payload?.run.startedAt})`);
  console.log(`   seed queries: ${result.payload?.run.seedQueries.join(", ")}`);
  console.log(`   키워드 수: ${result.payload?.items.length}`);

  console.log(`\n▶ Telegram 메시지 미리보기 (${result.messages.length}개 chunk)`);
  result.messages.forEach((message, index) => {
    console.log(`\n--- chunk ${index + 1}/${result.messages.length} (${message.length}자) ---`);
    console.log(message);
  });

  console.log(`\n▶ 발송 상태: sent=${result.sent}${result.reason ? ` (reason: ${result.reason})` : ""}`);
  console.log("\n✅ Keyword Notification 테스트 완료");
}

main().catch((error) => {
  console.error("❌ Keyword notification 테스트 실패:", error.message ?? error);
  process.exit(1);
});
