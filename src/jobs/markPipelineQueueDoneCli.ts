// job-research.yml/job-write.yml/job-revise.yml의 마지막 스텝(`if: always()`)에서 호출한다.
// 이 실행이 큐 항목(queue_id)을 대신하고 있었다면 done/failed로 마감하고, 곧바로 다음 대기
// 항목을 스스로 디스패치한다(pipelineQueue.ts의 체인 - 설계 배경은 그 파일 상단 주석 참고).
//
// queue_id가 없으면(수동 `gh workflow run job-research.yml -f job_id=...` 복구 실행 등,
// 큐를 거치지 않고 GitHub UI/CLI에서 직접 부른 경우) 아무것도 안 하고 조용히 끝난다 - 큐를
// 소유하지 않은 실행이 남의 락을 건드리면 안 된다.
//
// 사용법: npm run job:pipeline-drain -- <queue_id|""> <success|failure|cancelled>
import "dotenv/config";

import { markDoneAndDrain } from "../services/github/pipelineQueue.js";

async function main(): Promise<void> {
  const rawQueueId = process.argv[2]?.trim();
  const jobConclusion = process.argv[3]?.trim();

  if (!rawQueueId) {
    console.log("· [pipeline-drain] queue_id 없음(큐를 거치지 않은 실행) - 아무것도 안 함");
    return;
  }

  const queueId = Number(rawQueueId);
  if (!Number.isInteger(queueId)) {
    console.error(`❌ [pipeline-drain] queue_id가 정수가 아닙니다: ${rawQueueId}`);
    process.exitCode = 1;
    return;
  }

  const outcome = jobConclusion === "success" ? "done" : "failed";
  console.log(`▶ [pipeline-drain] queue_id=${queueId} -> ${outcome} 처리 + 다음 항목 디스패치 시도`);

  await markDoneAndDrain(queueId, outcome, {
    error: outcome === "failed" ? `job conclusion: ${jobConclusion ?? "unknown"}` : undefined,
  });

  console.log("✅ [pipeline-drain] 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
