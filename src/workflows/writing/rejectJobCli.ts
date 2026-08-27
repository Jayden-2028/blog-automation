// 자료조사 미리보기를 보고 원고로 쓸 가치가 없다고 판단한 job을 명시적으로 중단하는 진입점.
//
// 실제 상태 갱신은 rejectArticleJob.ts가 한다(터미널/Telegram 버튼이 같은 로직을 공유한다) -
// 이 파일은 argv 파싱과 사람이 읽을 출력만 담당한다.
//
// 사용법:
//   npm run job:reject -- <jobId> ["사유"]
import "dotenv/config";

import { rejectArticleJob } from "./rejectArticleJob.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const reason = process.argv[3] ?? "사전 확인 후 중단(사유 미기재)";

  if (!jobId) {
    console.log('사용법: npm run job:reject -- <jobId> ["사유"]');
    return;
  }

  const result = await rejectArticleJob(jobId, reason, "cli");

  if (result.status === "not_found") {
    console.log(`⏭ job을 찾을 수 없습니다: ${jobId}`);
    return;
  }

  if (result.status === "already_final") {
    console.log(`⏭ 이미 최종 상태라 중단할 수 없습니다 (상태: ${result.job.status})`);
    return;
  }

  console.log(`✅ 중단됨: ${result.job.keyword}`);
  console.log(`   사유: ${reason}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
