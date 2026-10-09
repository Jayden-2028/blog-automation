// Storage 정리 CLI(개편2.5 D). 실행: npm run storage:cleanup [-- --apply] [-- --days=14] [-- --rejected-days=7] [-- --notify]
//
// 기본은 dry-run이다. `--apply`를 줘야만 지운다(CLAUDE.md "원격 삭제는 승인 후"). `--notify`면 결과를 텔레그램(메인봇)으로 보고한다.
import "dotenv/config";

import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { formatCleanupReport, runStorageCleanup } from "./runStorageCleanup.js";

function numberFlag(name: string): number | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isNaN(value) || value < 0 ? undefined : value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const notify = process.argv.includes("--notify");
  const result = await runStorageCleanup({ apply, retentionDays: numberFlag("days"), rejectedRetentionDays: numberFlag("rejected-days") });

  console.log(
    `▶ [storage-cleanup] ${apply ? "APPLY" : "dry-run"} - 대상 ${result.candidateJobs}건, 객체 ${result.plan.paths.length}개, ` +
      `${(result.plan.bytes / 1024 / 1024).toFixed(1)}MB` + (apply ? `, 삭제 ${result.removed}개` : "")
  );
  console.log(`   보존: Blogspot ${result.skipped.blogspot_hotlink} / 발행처 불명 ${result.skipped.unknown_platform} / 미발행 ${result.skipped.not_published} / ${result.retentionDays}일 미경과 ${result.skipped.too_recent}`);
  console.log(
    `   반려분: 대상 ${result.rejectedCandidateJobs}건 (${result.rejectedRetentionDays}일 경과) / 보존 - 발행 이력 ${result.rejectedSkipped.has_publication} · ${result.rejectedRetentionDays}일 미경과 ${result.rejectedSkipped.too_recent} · 반려 시각 불명 ${result.rejectedSkipped.no_timestamp}`
  );
  if (!apply) for (const path of result.plan.paths.slice(0, 20)) console.log(`   - ${path}`);

  if (notify) {
    await TelegramNotifier.fromEnv()
      .sendMessages([{ text: formatCleanupReport(result) }])
      .catch((error) => console.warn(`⚠️ 알림 실패(무시): ${error instanceof Error ? error.message : error}`));
  }
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`❌ [storage-cleanup] 실패: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
