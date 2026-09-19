// "원고 준비 완료" 알림을 다시 보낸다(2026-09-19).
//
// 왜 필요한가: 발행 버튼(🚀 블로그 발행)은 알림 메시지에 붙어 있는데, 그 버튼을 처리하는 코드가
// 바뀌면 **이미 보낸 메시지의 버튼은 옛 코드로 처리된다**(텔레그램은 누를 때마다 서버로
// callback_data를 보내고, 서버는 그 시점 main을 체크아웃한다). 실제로 09-19 11:16 클릭이
// 배포 직전 커밋으로 돌아 아무 일도 일어나지 않았다. 고친 뒤에는 알림을 다시 보내 새 버튼을 준다.
//
// 알림 본문·버튼은 prepareApprovedManuscripts가 보내는 것과 완전히 같다(buildManuscriptReadyMessage
// 재사용) - 여기서 따로 문구를 만들지 않는다.
//
// 사용: npm run manuscripts:resend-notification -- --job=<uuid> [--dry-run]
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { loadManifest } from "./manuscriptManifest.js";
import { buildManuscriptReadyMessage, notifyManuscriptsReady } from "./notifyManuscriptsReady.js";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const jobId = argValue("job");
  if (!jobId) throw new Error("--job=<jobId>가 필요합니다.");
  const dryRun = process.argv.includes("--dry-run");

  const job = await ArticleJobRepository.findById(jobId);
  if (!job) throw new Error(`job을 찾을 수 없습니다: ${jobId}`);

  const manifest = await loadManifest();
  const topic = manifest.topics.find((entry) => entry.jobId === jobId);
  if (!topic) throw new Error(`원고가 아직 준비되지 않았습니다(manifest에 없음): ${jobId}`);

  const result = { job, result: { status: "success" as const, imageFailures: [], topic } };
  const message = buildManuscriptReadyMessage(result);

  console.log("─".repeat(60));
  console.log(message.text);
  console.log("버튼:", JSON.stringify(message.replyMarkup?.inline_keyboard ?? []));
  console.log("─".repeat(60));

  if (dryRun) {
    console.log("· --dry-run - 보내지 않았습니다.");
    return;
  }

  await notifyManuscriptsReady([result]);
  console.log("✅ 알림을 다시 보냈습니다.");
}

main().catch((error) => {
  console.error("❌ 재발송 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
