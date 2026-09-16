// 비용 집계를 지금 즉시 다시 만들어 보고 출력한다(npm run report:cost).
//
// 사용법:
//   npm run report:cost            manuscripts/cost.json 갱신 + 요약 출력
//   npm run report:cost -- --dry   파일을 쓰지 않고 화면에만(원격 배포 디렉터리를 안 건드린다)
//
// 배포는 하지 않는다. 배포는 원고 페이지 경로(manuscripts:build)가 디렉터리 통째로 한 번에 한다 -
// 여기서 따로 올리면 index.html이 없는 디렉터리를 배포해 뷰어를 날릴 수 있다.
import "dotenv/config";

import { listFixedCosts } from "../../config/fixedCosts.js";
import { manuscriptCostSnapshotPath } from "../../config/pipelinePaths.js";
import { ApiUsageRepository } from "../../repositories/ApiUsageRepository.js";
import { buildCostSummary } from "./buildCostSummary.js";
import { writeCostSnapshot } from "./writeCostSnapshot.js";
import type { CostSummary } from "./buildCostSummary.js";

function usd(value: number | null): string {
  return value == null ? "—" : `$${value.toFixed(4)}`;
}

function printSummary(summary: CostSummary): void {
  console.log(`\n📊 비용 집계 (${summary.timezone} 기준)\n`);
  console.log(`오늘 (${summary.today.date})    ${usd(summary.today.costUsd)}  ·  호출 ${summary.today.calls}건`);
  console.log(`이번 달 (${summary.month.month})  ${usd(summary.month.costUsd)}  ·  호출 ${summary.month.calls}건`);

  if (summary.month.unknownCostCalls > 0) {
    console.log(`⚠️ 금액 미상 ${summary.month.unknownCostCalls}건 - 위 금액은 하한입니다(단가 미등록 또는 usage 누락).`);
  }

  if (summary.byModel.length > 0) {
    console.log("\n모델별(이번 달)");
    for (const entry of summary.byModel) {
      console.log(`  ${entry.provider}/${entry.model} (${entry.operation})  ${usd(entry.costUsd)}  ·  ${entry.calls}건`);
    }
  } else {
    console.log("\n모델별(이번 달)  기록 없음 - 아직 계측된 유료 호출이 없습니다.");
  }

  console.log(
    `\n원고당(이번 달)  ${usd(summary.perManuscript.avgCostUsd)}  ·  원고 ${summary.perManuscript.jobs}건 합계 ${usd(summary.perManuscript.costUsd)}`
  );

  console.log("\n고정비(월)");
  for (const entry of summary.fixed.entries) {
    const amount = entry.monthlyUsd == null ? `미입력(${entry.envVar})` : usd(entry.monthlyUsd);
    console.log(`  ${entry.name} - ${entry.plan}: ${amount}`);
  }
  console.log(`  합계(입력된 것만): ${usd(summary.fixed.knownMonthlyUsd)}`);

  console.log("\n주의");
  for (const note of summary.notes) console.log(`  · ${note}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry");

  if (dryRun) {
    const since = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const rows = await ApiUsageRepository.listSince(since);
    printSummary(buildCostSummary({ rows, fixedCosts: listFixedCosts() }));
    console.log(`\n(--dry: ${manuscriptCostSnapshotPath()}를 쓰지 않았습니다.)`);
    return;
  }

  const result = await writeCostSnapshot();
  if (result.status === "failed") {
    console.error(`❌ 비용 집계 실패: ${result.error}`);
    process.exit(1);
  }

  printSummary(result.summary);
  console.log(`\n✅ 기록: ${result.path}`);
  console.log("   공개 URL에는 다음 원고 페이지 배포 때 함께 올라갑니다(npm run manuscripts:build -- --refresh).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
