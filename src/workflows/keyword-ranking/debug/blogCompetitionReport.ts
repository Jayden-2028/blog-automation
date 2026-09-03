// 블로그 경쟁도(문서 총 개수) 관측 리포트. **읽기 전용 — 아무것도 저장하지 않는다.**
//
// Phase A의 목적이 이 스크립트다: 포화도 임계값(config/keywordCompetition.ts의 low/highTotalThreshold)을
// 근거 없이 정할 수 없으므로, 실제 키워드들의 블로그 문서 수 분포를 먼저 눈으로 본다.
// 출력된 사분위수를 보고 "몇 건부터 레드오션인가"를 정한 뒤 Phase B(점수 반영)로 넘어간다.
//
// 실행:
//   npm run debug:blog-competition -- "추석 차례상" "부모급여 인상"   # 임의 키워드 직접 조회
//   npm run debug:blog-competition -- --latest 3                      # 최근 run 3건의 Top N 조회
//
// --latest는 keyword_rankings를 select만 한다(Supabase 자격증명 필요).
// 키워드를 직접 넘기는 경우에는 NAVER 자격증명만 있으면 된다.

import "dotenv/config";

import { BLOG_COMPETITION_CONFIG } from "../../../config/keywordCompetition.js";
import { computeSaturation, describeSaturation } from "../computeCompetitionScore.js";
import { probeBlogCompetition } from "../probeBlogCompetition.js";

function quantile(sortedValues: number[], ratio: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio));
  return sortedValues[index];
}

async function loadLatestRunKeywords(runCount: number): Promise<string[]> {
  // Supabase는 --latest를 쓸 때만 필요하므로 여기서 동적 import한다 -
  // 키워드를 직접 넘기는 경우 Supabase 자격증명 없이도 이 스크립트가 돌아야 한다.
  const { supabase: sb } = await import("../../../services/supabase/client.js");

  const { data: runs, error: runErr } = await sb
    .from("discovery_runs")
    .select("id, created_at, metadata")
    .order("id", { ascending: false })
    .limit(runCount);
  if (runErr) throw runErr;

  const keywords: string[] = [];
  for (const run of runs ?? []) {
    const kind = (run.metadata as Record<string, unknown> | null)?.kind ?? "morning";
    const { data: rows, error } = await sb
      .from("keyword_rankings")
      .select("rank, keyword")
      .eq("run_id", run.id)
      .order("rank", { ascending: true });
    if (error) throw error;

    console.log(`   run #${run.id} (${kind}): ${rows?.length ?? 0}건`);
    for (const row of rows ?? []) {
      if (typeof row.keyword === "string") keywords.push(row.keyword);
    }
  }

  return keywords;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const latestIndex = args.indexOf("--latest");

  let keywords: string[];
  if (latestIndex >= 0) {
    const runCount = Number.parseInt(args[latestIndex + 1] ?? "3", 10) || 3;
    console.log(`▶ 최근 run ${runCount}건의 Top 키워드를 불러옵니다 (읽기 전용)`);
    keywords = await loadLatestRunKeywords(runCount);
  } else {
    keywords = args.filter((arg) => !arg.startsWith("--"));
  }

  if (keywords.length === 0) {
    console.log("사용법:");
    console.log('  npm run debug:blog-competition -- "키워드1" "키워드2"');
    console.log("  npm run debug:blog-competition -- --latest 3");
    return;
  }

  console.log(
    `\n▶ 블로그 문서 총 개수 조회: ${keywords.length}건 ` +
      `(상한 ${BLOG_COMPETITION_CONFIG.probeMaxKeywords}, 지연 ${BLOG_COMPETITION_CONFIG.requestDelayMs}ms)`
  );

  const startedAt = Date.now();
  const result = await probeBlogCompetition(keywords);
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `\n조회 완료: ${result.probedCount}건 (실패 ${result.failedCount}건, ${(elapsedMs / 1000).toFixed(1)}초)\n`
  );

  const rows = [...result.totalByKeyword.entries()].sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1));
  for (const [keyword, total] of rows) {
    const saturation = computeSaturation(total);
    console.log(
      `  ${String(total ?? "실패").padStart(9)}건  ` +
        `${describeSaturation(saturation).padEnd(5)}  ` +
        `${saturation === null ? "  -  " : saturation.toFixed(2).padStart(5)}  ${keyword}`
    );
  }

  for (const [keyword, message] of Object.entries(result.errors)) {
    console.log(`  ⚠️ "${keyword}" 조회 실패 - ${message}`);
  }

  // 임계값 결정에 쓸 분포. 이 숫자를 보고 low/highTotalThreshold를 정한다.
  const measured = rows
    .map(([, total]) => total)
    .filter((total): total is number => typeof total === "number")
    .sort((a, b) => a - b);

  if (measured.length > 0) {
    console.log("\n▶ 분포 (임계값 결정용)");
    console.log(`   최소   : ${measured[0].toLocaleString()}건`);
    console.log(`   25%    : ${quantile(measured, 0.25)?.toLocaleString()}건`);
    console.log(`   중앙값 : ${quantile(measured, 0.5)?.toLocaleString()}건`);
    console.log(`   75%    : ${quantile(measured, 0.75)?.toLocaleString()}건`);
    console.log(`   최대   : ${measured[measured.length - 1].toLocaleString()}건`);
    console.log(
      `\n   현재 잠정 임계값: low=${BLOG_COMPETITION_CONFIG.lowTotalThreshold.toLocaleString()} / ` +
        `high=${BLOG_COMPETITION_CONFIG.highTotalThreshold.toLocaleString()}`
    );
    console.log(
      `   점수 반영 여부(applyToScore): ${BLOG_COMPETITION_CONFIG.applyToScore} ` +
        `(Phase A에서는 false가 정상 — 랭킹에 영향 없음)`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
