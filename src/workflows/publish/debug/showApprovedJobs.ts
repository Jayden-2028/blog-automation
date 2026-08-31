// approved/published job과 그 원고·발행 기록을 출력한다(읽기 전용). 다채널 발행 대상 확인용.
// 실행: npm run debug:approved-jobs
import "dotenv/config";

import { supabase as sb } from "../../../services/supabase/client.js";

async function main(): Promise<void> {
  const { data: jobs } = await sb
    .from("article_jobs")
    .select("id,keyword,category,status,updated_at")
    .in("status", ["approved", "published"])
    .order("updated_at", { ascending: false });

  for (const j of jobs ?? []) {
    const { data: arts } = await sb
      .from("articles")
      .select("id,title,status,platform,content")
      .eq("job_id", j.id);
    const artIds = (arts ?? []).map((a) => a.id);
    const { data: pubs } = artIds.length
      ? await sb.from("publications").select("platform,status,published_url,article_id").in("article_id", artIds)
      : { data: [] };

    console.log(`\n[${j.status}] ${j.keyword} (${j.category})  job=${j.id}`);
    for (const a of arts ?? []) {
      console.log(
        `  article #${a.id} platform=${a.platform ?? "null"} status=${a.status} len=${(a.content ?? "").length}  "${(a.title ?? "").slice(0, 44)}"`
      );
    }
    for (const p of pubs ?? []) {
      console.log(`  pub ${p.platform} ${p.status} ${p.published_url ?? ""}`);
    }
  }
  if ((jobs ?? []).length === 0) console.log("(approved/published job 없음)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
