// runCreatorAdvisorCollection 수동 실행 진입점.
//
// 기본은 dry-run이다 - 실제 브라우저로 Creator Advisor를 크롤링하되 trend_candidates에는 쓰지
// 않는다. 로그인 프로필이 아직 유효한지, 페이지 구조가 바뀌지 않았는지 확인하는 용도.
//
// 실제 저장까지 하려면 원격 DB 쓰기이므로 명시적으로 opt-in한다:
//   WRITE=1 npm run collect:creator-advisor
import "dotenv/config";

import { runCreatorAdvisorCollection } from "./runCreatorAdvisorCollection.js";

const shouldWrite = process.env.WRITE === "1";

async function main() {
  console.log(`▶ Creator Advisor 수집 시작 (모드: ${shouldWrite ? "실제 저장(WRITE=1)" : "dry-run(기본값, DB 쓰기 없음)"})`);

  // CLI에서는 config의 enabled 값과 무관하게 항상 수집을 시도한다 - "지금 크롤링이 되는지"를
  // 확인하는 도구이므로, enabled 게이트는 daily workflow 경로에만 적용한다.
  const result = await runCreatorAdvisorCollection({ enabled: true, dryRun: !shouldWrite });

  console.log(`\n▶ 결과: ${result.status}`);
  console.log(`   조회: ${result.fetchedCount}건`);
  console.log(`   저장: ${result.upsertedCount}건`);
  console.log(`   만료: ${result.expiredCount}건`);
  console.log(`   trendDate: ${result.trendDate ?? "N/A"}`);

  const topicErrorKeys = Object.keys(result.topicErrors);
  if (topicErrorKeys.length > 0) {
    console.log(`\n⚠️ topic 부분 실패 ${topicErrorKeys.length}건:`);
    for (const [key, message] of Object.entries(result.topicErrors)) {
      console.log(`   ${key}: ${message}`);
    }
  }

  if (result.status === "failed") {
    console.error(`\n❌ 실패: ${result.error}`);
    process.exit(1);
  }

  console.log("\n✅ 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
