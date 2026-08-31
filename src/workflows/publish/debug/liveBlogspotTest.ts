// 라이브 Blogspot 발행 실측(1회). 사용자 승인 후 수동 실행. draft로만 올린다.
// 실행: npx tsx src/workflows/publish/debug/liveBlogspotTest.ts <jobId>
import "dotenv/config";

import { publishArticleToBlogspot } from "../publishArticleToBlogspot.js";
import { TelegramNotifier } from "../../../notifications/TelegramNotifier.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("사용법: npx tsx src/workflows/publish/debug/liveBlogspotTest.ts <jobId>");
    process.exit(1);
  }

  console.log(`▶ Blogspot 실측 발행: ${jobId}`);
  const started = Date.now();
  const result = await publishArticleToBlogspot(jobId);
  console.log(`\n▶ 결과 (${Math.round((Date.now() - started) / 1000)}초):`);
  console.log(JSON.stringify(result, null, 2));

  if (result.ok) {
    await TelegramNotifier.fromEnv().sendMessages([
      {
        text:
          `🧪 <b>Blogspot 실측 발행 완료</b>\n\n` +
          `${result.isDraft ? "📝 비공개(draft)" : "✅ 공개"} · 배리에이션 ${result.variantCreated ? "신규 생성" : "재사용"}\n` +
          (result.url ? `\n${result.url}` : ""),
        replyMarkup: result.url ? { inline_keyboard: [[{ text: "Blogspot에서 확인", url: result.url }]] } : undefined,
      },
    ]);
    console.log("\n✅ Telegram 알림 발송");
  } else {
    console.error(`\n❌ 실패: ${result.reason} - ${result.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
