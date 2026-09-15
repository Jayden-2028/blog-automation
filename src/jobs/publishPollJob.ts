// approved 대기열을 비우는 폴러. launchd가 주기적으로 실행한다. SPRINT_5_DESIGN.md §5.
//
// 2026-09-05: 반자동 업로드(Playwright/API, publishApprovedArticles)는 원고 품질이 아직 재작성
// 수준으로 손봐야 하는 상태라 일단 중단한다 - 대신 채널 3종(네이버/티스토리/블로거) 원고를 준비해
// 로컬 페이지(manuscripts/index.html)에서 사람이 직접 복사해 붙여넣는다(prepareApprovedManuscripts).
// publishApprovedArticles.ts와 각 채널 발행 코드는 지우지 않았다 - 원고 품질이 올라오면 이 파일의
// 호출부만 되돌리면 반자동 업로드를 재개할 수 있다.
//
// telegram-poll과 같은 구조(짧게 반복 실행 + caffeinate + 파일 락)는 그대로 유지한다 - 배리에이션
// LLM(티스토리·블로거)도 수 분 걸려 콜백 안에서 돌리면 위험하기는 마찬가지다.
//
// 처리 시각 분산: 폴링 주기(launchd StartInterval 600) + 아래 랜덤 지터.
import "dotenv/config";

import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { prepareApprovedManuscripts } from "../workflows/manuscripts/prepareApprovedManuscripts.js";
import { notifyManuscriptsReady } from "../workflows/manuscripts/notifyManuscriptsReady.js";

const MAX_JITTER_MS = 90_000;

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.publish-poll.lock"));
  if (!lock) return;

  // 랜덤 지터. 이전 실행이 락으로 걸러진 뒤라 여기서 자도 겹치지 않는다.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * MAX_JITTER_MS)));

  const results = await prepareApprovedManuscripts();
  if (results.length === 0) return; // 대기열 없음 - 조용히 종료

  console.log(`▶ [publish-poll] approved job ${results.length}건 처리`);
  let hadFailure = false;
  for (const { job, result } of results) {
    if (result.status === "success") {
      console.log(`   ✅ ${job.keyword} - 원고 준비 완료(이미지 ${result.topic.manuscript.images.length}장)`);
    } else {
      console.log(`   ❌ ${job.keyword} - ${result.reason}`);
      hadFailure = true;
    }
  }

  await notifyManuscriptsReady(results);

  if (hadFailure) {
    // Telegram 알림은 notifyManuscriptsReady가 job별로 이미 보냈다 - 여기는 launchd 로그용.
    const failedLines = results
      .filter(({ result }) => result.status === "failed")
      .map(({ job, result }) => `${job.keyword}: ${result.status === "failed" ? result.reason : ""}`);
    console.error(failedLines.join("\n"));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ [publish-poll] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
