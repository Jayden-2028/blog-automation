// job-translate 진입점. 사용법: npm run job:translate -- <jobId> [feedback]
// TelegramBot의 한글 승인(✅)·영어본 수정 요청 답장이 job-translate.yml을 띄우고, 그 워크플로가 이걸 실행한다.
import "dotenv/config";

import { runTranslateJob } from "./runTranslateJob.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const feedback = process.argv[3];
  if (!jobId) {
    console.log("사용법: npm run job:translate -- <jobId> [feedback]");
    return;
  }

  console.log(`▶ 영어본 생성 시작: ${jobId}${feedback ? ` (수정 요청: ${feedback})` : ""}`);
  const result = await runTranslateJob(jobId, { feedback });

  if (result.status === "skipped") {
    console.log(`· 건너뜀: ${result.reason}`);
    return;
  }
  if (result.status === "failed") {
    console.error(`❌ 영어본 생성 실패: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 영어본 생성 완료 (시도 ${result.attempts}회) - "${result.parsed.title}"`);
}

main().catch((error) => {
  console.error("❌ [translate] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
