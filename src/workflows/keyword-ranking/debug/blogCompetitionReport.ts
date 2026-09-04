// 블로그 경쟁도(문서 총 개수) 관측 리포트. **읽기 전용 — 아무것도 저장하지 않는다.**
//
// Phase A의 목적이 이 스크립트다: 포화도 임계값(config/keywordCompetition.ts의 low/highTotalThreshold)을
// 근거 없이 정할 수 없으므로, 실제 키워드들의 블로그 문서 수 분포를 먼저 눈으로 본다.
//
// 두 가지를 나란히 보여준다(2026-09-04 실측 이후):
// - 주제어: extractTopicQueries()가 LLM으로 뽑은 주제구로 조회한 값. **이쪽이 실제로 쓸 값이다.**
//           출처 열이 LLM인지 폴백(규칙 기반)인지 함께 보여주므로 추출 품질을 눈으로 판단할 수 있다.
// - 원문  : canonical keyword 전체로 조회한 값. 문장을 통째로 검색해 "주제 포화도"가 아니라
//           "이 어투를 쓴 블로그 수"를 재던 값으로, 비교용으로만 남긴다.
//
// 표를 볼 때 확인할 것: 같은 사건의 서로 다른 헤드라인이 **같은 주제어로 수렴하는지**.
// 규칙 기반이 실패한 지점이 정확히 여기였다(부산 오피스텔 추락사 2건이 94배 차이).
//
// 실행:
//   npm run debug:blog-competition -- "추석 차례상 비용" "부모급여 인상"   # 임의 키워드 직접 조회
//   npm run debug:blog-competition -- --latest 3                          # 최근 run 3건의 Top N 조회
//
// --latest는 keyword_rankings를 select만 한다(Supabase 자격증명 필요).
// 키워드를 직접 넘기는 경우에는 NAVER 자격증명만 있으면 된다.

import "dotenv/config";

import { BLOG_COMPETITION_CONFIG } from "../../../config/keywordCompetition.js";
import { extractTopicQueries } from "../extractTopicQueries.js";
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

  // 상한을 원문/주제어 양쪽에 각각 적용하기 위해 여기서 미리 자른다.
  const capped = keywords.slice(0, BLOG_COMPETITION_CONFIG.probeMaxKeywords);

  console.log(`\n▶ 주제어 추출 중(헤드리스 1회, 최대 2분)...`);
  const extraction = await extractTopicQueries(capped.map((keyword) => ({ keyword })));
  console.log(
    `   ${extraction.status} — LLM ${extraction.queries.filter((q) => q.source === "llm").length}건 / ` +
      `폴백 ${extraction.queries.filter((q) => q.source === "fallback").length}건` +
      `${extraction.error ? ` (${extraction.error})` : ""} (${(extraction.durationMs / 1000).toFixed(1)}초)`
  );

  const targets = capped.map((keyword, index) => ({
    keyword,
    query: extraction.queries[index]?.query ?? keyword,
    querySource: extraction.queries[index]?.source ?? "fallback",
  }));

  console.log(
    `\n▶ 블로그 문서 총 개수 조회: ${targets.length}건 x 2(주제어/원문), 지연 ${BLOG_COMPETITION_CONFIG.requestDelayMs}ms`
  );

  const startedAt = Date.now();
  const coreResult = await probeBlogCompetition(
    targets.map((target) => target.query),
    { maxKeywords: targets.length }
  );
  const rawResult = await probeBlogCompetition(
    targets.map((target) => target.keyword),
    { maxKeywords: targets.length }
  );
  const elapsedMs = Date.now() - startedAt;

  const failedCount = coreResult.failedCount + rawResult.failedCount;
  console.log(`\n조회 완료: ${targets.length}건 (실패 ${failedCount}건, ${(elapsedMs / 1000).toFixed(1)}초)\n`);

  const rows = targets
    .map((target) => ({
      ...target,
      coreTotal: coreResult.totalByKeyword.get(target.query) ?? null,
      rawTotal: rawResult.totalByKeyword.get(target.keyword) ?? null,
    }))
    .sort((a, b) => (b.coreTotal ?? -1) - (a.coreTotal ?? -1));

  console.log("    주제어건수  등급   포화   원문건수  출처  주제어 / 원문 키워드");
  for (const row of rows) {
    const saturation = computeSaturation(row.coreTotal);
    console.log(
      `  ${String(row.coreTotal ?? "실패").padStart(9)}  ` +
        `${describeSaturation(saturation).padEnd(5)}  ` +
        `${saturation === null ? "  -  " : saturation.toFixed(2).padStart(5)}  ` +
        `${String(row.rawTotal ?? "실패").padStart(8)}  ` +
        `${row.querySource === "llm" ? "LLM " : "폴백"}  ` +
        `[${row.query}]  ${row.keyword}`
    );
  }

  for (const [keyword, message] of Object.entries({ ...coreResult.errors, ...rawResult.errors })) {
    console.log(`  ⚠️ "${keyword}" 조회 실패 - ${message}`);
  }

  // 임계값 결정에 쓸 분포. 주제어 기준으로만 낸다 - 실제로 점수에 쓸 값이기 때문이다.
  const measured = rows
    .map((row) => row.coreTotal)
    .filter((total): total is number => typeof total === "number")
    .sort((a, b) => a - b);

  if (measured.length > 0) {
    console.log("\n▶ 주제어 기준 분포 (임계값 결정용)");
    console.log(`   최소   : ${measured[0].toLocaleString()}건`);
    console.log(`   10%    : ${quantile(measured, 0.1)?.toLocaleString()}건`);
    console.log(`   25%    : ${quantile(measured, 0.25)?.toLocaleString()}건`);
    console.log(`   중앙값 : ${quantile(measured, 0.5)?.toLocaleString()}건`);
    console.log(`   75%    : ${quantile(measured, 0.75)?.toLocaleString()}건`);
    console.log(`   90%    : ${quantile(measured, 0.9)?.toLocaleString()}건`);
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
