// 자료조사 미리보기를 보고 원고로 쓸 가치가 없다고 판단한 job을 명시적으로 중단하는 진입점.
//
// 왜 필요한가(SPRINT_2_DESIGN.md 13-3절 ④): 사전 확인 체크포인트(job:research)에서 중단을
// 선택한 이력이 곧 "어떤 키워드 패턴이 가치가 낮은지"를 판단할 데이터가 된다. Sprint 1에서
// Telegram Pass 버튼의 거부 이력을 남기기로 한 것과 같은 이유다 - 지금 기록해두지 않으면
// 나중에 소급할 수 없다.
//
// 사용법:
//   npm run job:reject -- <jobId> ["사유"]
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";

const NON_REJECTABLE_STATUSES = ["approved", "published", "rejected"] as const;

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const reason = process.argv[3] ?? "사전 확인 후 중단(사유 미기재)";

  if (!jobId) {
    console.log('사용법: npm run job:reject -- <jobId> ["사유"]');
    return;
  }

  const job = await ArticleJobRepository.findById(jobId);
  if (!job) {
    console.log(`⏭ job을 찾을 수 없습니다: ${jobId}`);
    return;
  }

  if ((NON_REJECTABLE_STATUSES as readonly string[]).includes(job.status)) {
    console.log(`⏭ 이미 최종 상태라 중단할 수 없습니다 (상태: ${job.status})`);
    return;
  }

  await ArticleJobRepository.mergeMetadata(jobId, {
    rejectedReason: reason,
    rejectedVia: "cli",
    rejectedAt: new Date().toISOString(),
    // 어느 단계에서 중단했는지 남긴다 - "조사 후 중단"과 "작성 후 중단"은 원인이 다르다
    // (전자는 대개 키워드 자체의 가치 문제, 후자는 원고 품질 문제일 가능성이 높다).
    rejectedAtStatus: job.status,
  });
  await ArticleJobRepository.updateStatus(jobId, "rejected");

  console.log(`✅ 중단됨: ${job.keyword}`);
  console.log(`   사유: ${reason}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
