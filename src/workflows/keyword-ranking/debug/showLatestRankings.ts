// 최근 discovery_run 몇 건의 Top N을 그대로 출력한다(읽기 전용, 아무것도 저장하지 않는다).
// Top 10 중복/편중을 눈으로 확인할 때 쓴다.
// 실행: npm run debug:latest-rankings [runCount]
import "dotenv/config";

import { supabase as sb } from "../../../services/supabase/client.js";

async function main(): Promise<void> {
  const runCount = Number.parseInt(process.argv[2] ?? "3", 10);

  const { data: runs, error: runErr } = await sb
    .from("discovery_runs")
    .select("id, created_at, metadata, candidates_count, clusters_count")
    .order("id", { ascending: false })
    .limit(runCount);
  if (runErr) throw runErr;

  for (const run of runs ?? []) {
    const kind = (run.metadata as Record<string, unknown> | null)?.kind ?? "morning";
    console.log(`\n=== run #${run.id} (${run.created_at}) kind=${kind} ===`);

    const { data: rows, error } = await sb
      .from("keyword_rankings")
      .select("rank, keyword, headline, category, total_score, seed_query, reason")
      .eq("run_id", run.id)
      .order("rank", { ascending: true });
    if (error) throw error;

    for (const r of rows ?? []) {
      console.log(
        `  #${String(r.rank).padStart(2)} [${String(r.category ?? "-").padEnd(13)}] ` +
          `${String(r.total_score ?? "?").toString().padStart(3)}점  seed=${r.seed_query ?? "-"}  ${r.keyword}` +
          (r.headline && r.headline !== r.keyword ? `\n        원문: ${r.headline}` : "")
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
