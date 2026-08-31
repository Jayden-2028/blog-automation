// approved job들에 defaultPreflight를 돌려 발행 가능 여부만 출력한다(읽기 전용).
import "dotenv/config";

import { ArticleJobRepository } from "../src/repositories/ArticleJobRepository.js";
import { defaultPreflight } from "../src/workflows/publish/publishApprovedArticles.js";

const jobs = await ArticleJobRepository.listByStatus("approved", 20);
for (const job of jobs) {
  const blocker = await defaultPreflight(job);
  console.log(`${blocker ? "⛔" : "✅"} ${job.keyword.slice(0, 40)}  ${blocker ?? "발행 가능"}`);
}
if (jobs.length === 0) console.log("(approved job 없음)");
