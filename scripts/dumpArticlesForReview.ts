// job 1건의 기준 원고 + 배리에이션 원고 전문을 파일로 뽑는다(리뷰용, 읽기 전용).
// 실행: npx tsx scripts/dumpArticlesForReview.ts <jobId>
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

import { listArticlesByJobId } from "../src/services/supabase/repositories/articleRepository.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("사용법: npx tsx scripts/dumpArticlesForReview.ts <jobId>");
    process.exit(1);
  }
  const articles = await listArticlesByJobId(jobId);
  const dir = `.local/osmu-review/${jobId}`;
  mkdirSync(dir, { recursive: true });

  for (const a of articles) {
    const name = `article-${a.id}_${a.platform ?? "base"}_${a.status}.md`;
    const header = `# ${a.title}\n\n> id=${a.id} platform=${a.platform ?? "base"} status=${a.status} len=${(a.content ?? "").length} created=${a.created_at}\n\n---\n\n`;
    writeFileSync(`${dir}/${name}`, header + (a.content ?? ""), "utf-8");
    console.log(`${name}  (${(a.content ?? "").length}자)`);
  }
  console.log(`\n-> ${dir}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
