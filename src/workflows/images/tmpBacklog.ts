import "dotenv/config";
import { writeFileSync } from "node:fs";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { listPublicationsByArticleIds } from "../../services/supabase/repositories/publicationRepository.js";

async function main() {
  const rows = (await ArticleJobRepository.listRecent(200)) as any[];
  const pending = rows.filter((r) => !["published", "rejected", "closed"].includes(String(r.status)));
  const byStatus: Record<string, number> = {};
  const unpublished: any[] = [];
  let publishedButPending = 0;
  for (const j of pending) {
    const arts = await listArticlesByJobId(j.id);
    const pubs = await listPublicationsByArticleIds(arts.map((a: any) => a.id));
    if (pubs.some((p: any) => p.status === "published")) { publishedButPending += 1; continue; }
    unpublished.push(j);
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
  }
  console.log(`대기 상태 job ${pending.length}건`);
  console.log(`  이미 발행됨(status만 안 바뀜): ${publishedButPending}건 → 건드릴 필요 없음`);
  console.log(`  진짜 미발행 잔재: ${unpublished.length}건`);
  console.log(`    ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  const oldest = unpublished[unpublished.length - 1];
  console.log(`  가장 오래된 것: ${String(oldest?.created_at).slice(0, 10)}`);
  console.log(`\n  오늘(09-21) 미발행: ${unpublished.filter((j) => String(j.created_at).startsWith("2026-09-21")).map((j) => j.keyword.slice(0, 20)).join(" / ")}`);
  writeFileSync("/tmp/backlog-ids.txt", unpublished.map((j) => `${j.id} ${j.keyword}`).join("\n"));
  console.log("\n  전체 목록: /tmp/backlog-ids.txt");
}
main();
