// 같은 키워드를 **자율 모드로 한 번 더** 돌리기 위한 job 복제(2026-09-23 검증용).
//
// 왜 복제하나: A/B는 같은 키워드에 두 원고가 나와야 비교가 된다. 기존 job을 그대로 다시 돌리면
// 이미 승인된 원고·이미지·발행 이력이 있는 row를 건드리게 된다. 그래서 **새 job을 만들고**
// metadata.writingMode='auto'만 박는다. 원본 job은 한 글자도 손대지 않는다.
//
// 랭크 오프셋을 쓰는 이유: article_jobs에 (source_run_id, source_rank) 유니크 인덱스가 있다
// (uq_article_jobs_run_rank). 같은 run의 같은 rank로는 두 번 못 넣으므로 rank에 오프셋을 더해
// 자리를 비켜준다. 발굴 랭킹이 1,000위까지 가지 않으므로 충돌하지 않는다.
//
// 사용법:
//   npx tsx scripts/cloneJobForWritingModeAB.ts <jobId>              # dry-run (기본)
//   npx tsx scripts/cloneJobForWritingModeAB.ts <jobId> --confirm    # 실제 생성
//   npx tsx scripts/cloneJobForWritingModeAB.ts <jobId> --confirm --mode spec
//
// 만든 뒤:
//   npm run job:write -- <새 jobId>
import "dotenv/config";

import { ArticleJobRepository } from "../src/repositories/ArticleJobRepository.js";
import { supabase } from "../src/services/supabase/client.js";
import { WRITING_MODES, WRITING_MODE_KEY } from "../src/config/writingMode.js";
import type { WritingMode } from "../src/config/writingMode.js";
import type { ArticleJobInsert } from "../src/types/database.js";

/** 원본 rank에 더할 값. 발굴 랭킹이 여기까지 오지 않으므로 유니크 인덱스와 부딪히지 않는다. */
const RANK_OFFSET = 1000;

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId || jobId.startsWith("--")) {
    console.error("사용법: npx tsx scripts/cloneJobForWritingModeAB.ts <jobId> [--confirm] [--mode auto|spec]");
    process.exit(1);
  }

  const modeRaw = readFlag("mode") ?? "auto";
  if (!(WRITING_MODES as readonly string[]).includes(modeRaw)) {
    console.error(`--mode는 ${WRITING_MODES.join(" | ")} 중 하나여야 합니다 (받은 값: ${modeRaw})`);
    process.exit(1);
  }
  const mode = modeRaw as WritingMode;
  const confirm = process.argv.includes("--confirm");
  const offset = Number(readFlag("rank-offset") ?? RANK_OFFSET);

  const source = await ArticleJobRepository.findById(jobId);
  if (!source) {
    console.error(`job을 찾지 못했습니다: ${jobId}`);
    process.exit(1);
  }

  const targetRank = source.source_rank + offset;

  console.log("원본 job");
  console.log(`  id       ${source.id}`);
  console.log(`  keyword  ${source.keyword}`);
  console.log(`  category ${source.category ?? "-"}`);
  console.log(`  run/rank ${source.source_run_id} / ${source.source_rank}`);
  console.log("");
  console.log("만들 job");
  console.log(`  keyword  ${source.keyword}   (동일)`);
  console.log(`  run/rank ${source.source_run_id} / ${targetRank}   (rank +${offset})`);
  console.log(`  status   selected`);
  console.log(`  metadata { ${WRITING_MODE_KEY}: "${mode}", abSourceJobId: "${source.id}" }`);
  console.log("");

  // 같은 자리에 이미 복제본이 있으면 다시 만들지 않는다 - 두 번 돌려 중복 job을 쌓지 않기 위해서다.
  const existing = await ArticleJobRepository.findByRunAndRank(source.source_run_id, targetRank);
  if (existing) {
    console.log(`이미 있습니다: ${existing.id} (status=${existing.status})`);
    console.log(`실행: npm run job:write -- ${existing.id}`);
    return;
  }

  if (!confirm) {
    console.log("dry-run입니다. 실제로 만들려면 --confirm을 붙이세요.");
    return;
  }

  const row: ArticleJobInsert = {
    source_run_id: source.source_run_id,
    source_rank: targetRank,
    keyword: source.keyword,
    headline: source.headline,
    seed_query: source.seed_query,
    category: source.category,
    total_score: source.total_score,
    score_breakdown: source.score_breakdown,
    status: "selected",
    selected_via: "manual",
    metadata: { [WRITING_MODE_KEY]: mode, abSourceJobId: source.id },
  };

  const { data, error } = await supabase.from("article_jobs").insert(row).select().single();
  if (error || !data) throw error ?? new Error("insert가 row를 반환하지 않았습니다.");

  console.log(`✅ 만들었습니다: ${data.id}`);
  console.log(`실행: npm run job:write -- ${data.id}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
