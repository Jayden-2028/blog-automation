// generateArticleVariant를 실제 claude -p로 1회 실행해 샘플을 파일로 뽑는다(리뷰용).
// 발행/DB 쓰기 없음. 실행: npx tsx scripts/genVariantSample.ts <jobId>
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

import { listArticlesByJobId } from "../src/services/supabase/repositories/articleRepository.js";
import { generateArticleVariant } from "../src/workflows/writing/generateArticleVariant.js";

async function main(): Promise<void> {
  const [jobId] = process.argv.slice(2);
  if (!jobId) {
    console.error("사용법: npx tsx scripts/genVariantSample.ts <jobId>");
    process.exit(1);
  }
  const articles = await listArticlesByJobId(jobId);
  const base = [...articles].reverse().find((a) => a.platform == null);
  if (!base) {
    console.error("기준 원고 없음");
    process.exit(1);
  }

  console.log("▶ Blogspot 배리에이션 생성 중 (claude -p, 수 분)...");
  const started = Date.now();
  const result = await generateArticleVariant({
    category: null,
    baseTitle: base.title ?? "",
    baseBody: base.content ?? "",
  });
  console.log(`   ${Math.round((Date.now() - started) / 1000)}초, ${result.status}`);
  if (result.status !== "success") {
    console.error(result.error);
    process.exit(1);
  }

  const dir = `.local/osmu-review/${jobId}`;
  mkdirSync(dir, { recursive: true });
  const v = result.variant;
  const out = [
    `# ${v.title}`,
    ``,
    `> channel=${channel}  slug=${v.slug ?? "-"}`,
    `> searchDescription: ${v.searchDescription ?? "-"}`,
    `> tags: ${v.tags.join(", ")}`,
    ``,
    `---`,
    ``,
    v.body,
  ].join("\n");
  const path = `${dir}/variant-sample_${channel}_${Date.now()}.md`;
  writeFileSync(path, out, "utf-8");
  console.log(`-> ${path}  (본문 ${v.body.length}자, 태그 ${v.tags.length}개)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
