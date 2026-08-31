// approved 발행 대기열을 비우는 폴러. launchd가 주기적으로 실행한다. SPRINT_5_DESIGN.md §5.
//
// telegram-poll과 같은 구조(짧게 반복 실행 + caffeinate + 파일 락). 승인 콜백 안에서 발행하지
// 않는 이유는 publishApprovedArticles.ts 상단 주석 참고 - 배리에이션 LLM/티스토리 Playwright가
// 수 분 걸려 콜백을 멈추고, 잠자기 중 죽으면 발행이 유실된다.
//
// 발행 시각 분산: 폴링 주기(launchd StartInterval 600) + 아래 랜덤 지터로, 승인 직후 정각에
// 여러 채널을 몰아 올리지 않는다(§6 - 스팸 필터 방어).
import "dotenv/config";

import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { publishApprovedArticles } from "../workflows/publish/publishApprovedArticles.js";
import { notifyMultiPublish } from "../workflows/publish/notifyMultiPublish.js";

const MAX_JITTER_MS = 90_000;

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.publish-poll.lock"));
  if (!lock) return;

  // 랜덤 지터. 이전 실행이 락으로 걸러진 뒤라 여기서 자도 겹치지 않는다.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * MAX_JITTER_MS)));

  const results = await publishApprovedArticles();
  if (results.length === 0) return; // 대기열 없음 - 조용히 종료

  console.log(`▶ [publish-poll] approved job ${results.length}건 처리`);
  let hadFailure = false;
  for (const { job, channels, markedPublished } of results) {
    for (const c of channels) {
      const detail = c.status === "published" || c.status === "draft" || c.status === "already_done" ? c.url : (("reason" in c && c.reason) || "");
      console.log(`   [${c.channel}] ${c.status}${detail ? ` - ${detail}` : ""} (job ${job.id})`);
      if (c.status === "failed") hadFailure = true;
    }
    if (markedPublished) console.log(`   ✅ job ${job.id} -> published`);
  }

  await notifyMultiPublish(results);

  if (hadFailure) {
    const failedLines = results.flatMap(({ job, channels }) =>
      channels
        .filter((c) => c.status === "failed")
        .map((c) => `${job.keyword} / ${c.channel}: ${"reason" in c ? c.reason : ""}`)
    );
    await notifyPipelineFailure(`다채널 발행 실패 ${failedLines.length}건`, []).catch(() => {});
    console.error(failedLines.join("\n"));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ [publish-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
