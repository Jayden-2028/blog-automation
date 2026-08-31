// article_jobs 1건의 자료조사만 실행하고 멈추는 수동 진입점(사전 확인 체크포인트).
//
// 왜 필요한가(SPRINT_2_DESIGN.md 13절, 2026-08-27): 첫 실측에서 원고 자체는 정확했지만, 수집된
// 근거 안에 "이미 마감된 이벤트"라는 핵심 정보가 있었는데도 3분 분량의 LLM 비용을 쓴 뒤에야
// 그 사실을 알게 됐다. 조사(2초, 비용 0)만 먼저 하고 사람이 값싸게 판단할 기회를 준다.
//
// 사용법:
//   npm run job:research -- <jobId>
import "dotenv/config";

import { runResearchStage } from "../writing/runArticleJob.js";
import { notifyResearchReady } from "./notifyResearchReady.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.log("사용법: npm run job:research -- <jobId>");
    console.log("jobId 목록은 npm run job:write (인자 없이)로 확인할 수 있습니다.");
    return;
  }

  console.log(`▶ 자료조사 시작: ${jobId}`);

  const result = await runResearchStage(jobId);

  if (result.status === "skipped") {
    console.log(`⏭ 건너뜀: ${result.reason}`);
    return;
  }

  if (result.status === "failed") {
    console.error(`❌ 실패: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n▶ 결과: success (${Math.round(result.durationMs / 1000)}초, 근거 ${result.sources.length}건)`);
  console.log(`   verdict: ${result.verdict}`);
  console.log(`   등급: ${JSON.stringify(result.sourceCounts)}`);
  console.log(`   파일: ${result.researchFilePath}`);

  console.log("\n▶ Telegram으로 미리보기 발송 중...");
  await notifyResearchReady(result.job, result.researchFilePath, result.sources);
  console.log("✅ 완료 - Telegram에서 확인 후 진행/중단을 결정해주세요");
  console.log(`   진행: npm run job:write -- ${jobId}`);
  console.log(`   중단: npm run job:reject -- ${jobId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
