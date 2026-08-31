// 티스토리 임시저장 라이브 실측(1회). 사용자 승인 후 수동 실행. headless:false로 직접 지켜본다.
// TistoryPublisher.saveDraft의 미검증 가설(tinymce.setContent, 이미지, 저장 신호, 태그)만 확인한다 -
// 배리에이션 LLM은 건너뛰고 지정 job의 기준 원고를 그대로 쓴다.
//
// 실행: npx tsx src/services/publish/tistory/liveTistoryTest.ts <jobId>
import "dotenv/config";

import { listArticlesByJobId } from "../../supabase/repositories/articleRepository.js";
import { convertArticleToHtml } from "../convertArticleToHtml.js";
import { TistoryPublisher } from "./TistoryPublisher.js";
import { TelegramNotifier } from "../../../notifications/TelegramNotifier.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("사용법: npx tsx src/services/publish/tistory/liveTistoryTest.ts <jobId>");
    process.exit(1);
  }

  const articles = await listArticlesByJobId(jobId);
  const base = [...articles].reverse().find((a) => a.platform == null);
  if (!base) {
    console.error(`job ${jobId}에 기준 원고가 없습니다.`);
    process.exit(1);
  }

  const bodyHtml = convertArticleToHtml(base.content ?? "");
  console.log(`▶ 티스토리 임시저장 실측: "${base.title}"`);
  console.log(`   본문 HTML ${bodyHtml.length}자, <img> ${(bodyHtml.match(/<img /g) ?? []).length}개`);
  console.log("   브라우저 창이 열립니다. 직접 지켜보세요. (임시저장만 - '완료' 버튼은 누르지 않습니다)\n");

  const started = Date.now();
  const result = await new TistoryPublisher({ headless: false }).saveDraft({
    title: `[실측] ${base.title ?? jobId}`,
    bodyHtml,
    tags: ["실측"],
  });

  console.log(`\n▶ 결과 (${Math.round((Date.now() - started) / 1000)}초):`);
  console.log(JSON.stringify(result, null, 2));

  if (result.ok) {
    await TelegramNotifier.fromEnv().sendMessages([
      {
        text: `🧪 <b>티스토리 임시저장 실측 완료</b>\n\n임시저장 글 목록에서 확인하세요:\n${result.draftUrl}`,
        replyMarkup: { inline_keyboard: [[{ text: "임시저장 글 목록", url: result.draftUrl }]] },
      },
    ]);
    console.log("\n✅ Telegram 알림 발송. 티스토리 임시저장 글 목록에서 제목/본문/이미지/태그를 눈으로 확인하세요.");
    console.log("   브라우저는 열어둡니다 - 종료는 Ctrl+C.");
  } else {
    console.error(`\n❌ [${result.stage}] ${result.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
