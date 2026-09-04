// job 목록 HTML 리포트를 만든다. 읽기 전용(Supabase select만) - 어떤 상태도 바꾸지 않는다.
//
// 사용법:
//   npm run report:jobs            최근 200건을 logs/jobs.html로
//   npm run report:jobs -- 500     건수 지정
//
// 만들어진 파일을 브라우저로 열어 북마크해두고, 필요할 때 이 명령으로 갱신하면 된다.
import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobIds } from "../../services/supabase/repositories/articleRepository.js";
import { buildJobsReportHtml } from "./buildJobsReportHtml.js";
import type { JobsReportRow } from "./buildJobsReportHtml.js";

const DEFAULT_LIMIT = 200;
const OUTPUT_PATH = resolve("logs/jobs.html");

async function main(): Promise<void> {
  const limitArg = Number.parseInt(process.argv[2] ?? "", 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT;

  console.log(`▶ 최근 job ${limit}건 조회 중...`);
  const jobs = await ArticleJobRepository.listRecent(limit);

  // 원고 제목은 배리에이션이 아닌 기준 원고(platform == null)에서 가져온다. 같은 job에 재작성으로
  // 여러 건이 쌓여 있으면 가장 마지막 것이 현재 제목이다.
  const articles = await listArticlesByJobIds(jobs.map((job) => job.id));
  const titleByJobId = new Map<string, string>();
  for (const article of articles) {
    if (article.platform != null || !article.job_id || !article.title) continue;
    titleByJobId.set(article.job_id, article.title);
  }

  const rows: JobsReportRow[] = jobs.map((job) => ({
    jobId: job.id,
    articleTitle: titleByJobId.get(job.id) ?? null,
    headline: job.headline,
    keyword: job.keyword,
    category: job.category,
    status: job.status,
    selectedAt: job.selected_at,
  }));

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, buildJobsReportHtml(rows), "utf8");

  const withTitle = rows.filter((row) => row.articleTitle).length;
  console.log(`✅ ${rows.length}건 (원고 제목 있음 ${withTitle}건) -> ${OUTPUT_PATH}`);
  console.log(`   열기: open ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("❌ 리포트 생성 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
