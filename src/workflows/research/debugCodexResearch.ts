// Codex 자료조사 경로의 실측 스모크 테스트. 실제 Codex CLI를 1회 호출한다(ChatGPT 구독이라
// 호출당 과금은 없지만 1건당 143k~325k 토큰을 먹어 Plus 한도를 쓴다).
//
// article_jobs/DB는 건드리지 않는다 - 순수하게 "이 키워드로 Codex가 researcher.md 규격대로 쓸 만한
// 파일을 만드는가, stdout 파싱이 왕복하는가"만 확인한다. RESEARCH_PROVIDER 값과 무관하게 항상 Codex다.
//
// 사용법:
//   npm run debug:codex-research -- "키워드" [topic]
//
// 결과 파일: research/<슬러그>-codex-smoketest.md (실제 파이프라인 파일과 겹치지 않는 이름)
import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PIPELINE_ROOT, keywordSlug } from "../../config/pipelinePaths.js";
import { runCodexResearch } from "../../services/llm/runCodexResearch.js";
import { parseResearchFile } from "./parseResearchFile.js";

async function main(): Promise<void> {
  const keyword = process.argv[2];
  const category = process.argv[3] ?? null;
  if (!keyword) {
    console.log('사용법: npm run debug:codex-research -- "키워드" [topic]');
    return;
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  console.log(`▶ Codex 호출 중... (keyword: ${keyword}) - 최대 25분`);

  const result = await runCodexResearch({
    job: { keyword, headline: null, category },
    baselineSources: [],
    today,
    label: `smoketest-${keywordSlug(keyword)}`,
  });

  if (!result.ok) {
    console.error(`❌ 실패 (${Math.round(result.durationMs / 1000)}초): ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 응답 수신 (${Math.round(result.durationMs / 1000)}초, ${result.markdown.length}자)`);

  const outputPath = resolve(PIPELINE_ROOT, "research", `${keywordSlug(keyword)}-codex-smoketest.md`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${result.markdown.trim()}\n`, "utf8");
  console.log(`   저장: ${outputPath}`);

  // URL 검증(enforceGeminiGroundingUrls)은 **적용하지 않는다** - Codex에는 grounding 메타데이터가
  // 없어 허용 URL 집합을 만들 수 없고, 적용하면 전건이 community로 강등돼 모든 조사가 thin이 된다.
  const parsed = parseResearchFile(result.markdown);
  console.log("\n▶ researcher.md 규격 파싱 결과");
  console.log(`   keyword 일치: ${parsed.keyword === keyword ? "✅" : `❌ (파일: "${parsed.keyword}")`}`);
  console.log(`   verdict(파일 표기): ${parsed.verdict}`);
  console.log(`   source_counts: ${JSON.stringify(parsed.sourceCounts)}`);
  console.log(`   §10 출처 표 행 수: ${parsed.sourceTable.length}`);
  console.log(`   §4 미확인 통설: ${parsed.unverifiedClaims.length}건`);
  const official = parsed.sourceTable.filter((row) => row.authority === "official").length;
  const goKr = parsed.sourceTable.filter((row) => row.url?.includes(".go.kr")).length;
  console.log(`   official 등급 ${official}건 · go.kr ${goKr}건`);
  console.log("\n(실제 파이프라인에서는 verdict를 computeResearchVerdict가 저장된 sources 숫자에서 다시 계산한다.)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
