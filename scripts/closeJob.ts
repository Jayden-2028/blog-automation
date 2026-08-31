// article_jobs 1건을 발행 없이 종료 처리한다(status -> published, 폴러가 다시 집지 않게).
// 테스트 잔재나 "발행 안 할" job을 발행 대기열에서 빼는 용도. 실제 원격 DB write이므로
// CLAUDE.md 승인 게이트 대상 - 사용자가 직접 실행한다.
//
// 실행: npx tsx scripts/closeJob.ts <jobId> "<사유>"
import "dotenv/config";

import { supabase } from "../src/services/supabase/client.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const reason = process.argv[3] ?? "manually closed";
  if (!jobId) {
    console.error('사용법: npx tsx scripts/closeJob.ts <jobId> "<사유>"');
    process.exit(1);
  }

  const { data: before, error: readErr } = await supabase
    .from("article_jobs")
    .select("id,keyword,status")
    .eq("id", jobId)
    .single();
  if (readErr || !before) {
    console.error(`job을 찾을 수 없습니다: ${jobId} (${readErr?.message ?? ""})`);
    process.exit(1);
  }
  console.log(`대상: "${before.keyword}" (현재 status: ${before.status})`);

  const { data: job, error } = await supabase
    .from("article_jobs")
    .update({ status: "published", metadata: { closedReason: reason, closedAt: new Date().toISOString() } })
    .eq("id", jobId)
    .select("id,status")
    .single();
  if (error) {
    console.error(`job 업데이트 실패: ${error.message}`);
    process.exit(1);
  }

  const { data: arts, error: artErr } = await supabase
    .from("articles")
    .update({ status: "published" })
    .eq("job_id", jobId)
    .neq("status", "published")
    .select("id");
  if (artErr) console.warn(`article 업데이트 경고: ${artErr.message}`);

  console.log(`✅ job ${job?.id} -> published, article ${arts?.length ?? 0}건 정리. 발행 대기열에서 제외됩니다.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
