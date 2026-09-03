// Gemini 자료조사 경로의 실측 스모크 테스트. 실제 Gemini API를 1회 호출한다(과금 발생).
// article_jobs/DB는 건드리지 않는다 - 순수하게 "이 키워드로 Gemini가 researcher.md 규격대로
// 쓸 만한 파일을 만드는가"만 확인한다. RESEARCH_PROVIDER 값과 무관하게 항상 Gemini로 부른다.
//
// 사용법:
//   npm run debug:gemini-research -- "키워드" [topic]
//
// 결과 파일: research/<슬러그>-gemini-smoketest.md (실제 파이프라인 파일과 겹치지 않는 이름)
import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PIPELINE_ROOT, keywordSlug } from "../../config/pipelinePaths.js";
import { buildGeminiResearchPrompt } from "./buildGeminiResearchPrompt.js";
import { runGeminiResearch } from "../../services/llm/runGeminiResearch.js";
import { enforceGeminiGroundingUrls } from "./enforceGeminiGroundingUrls.js";
import { parseResearchFile } from "./parseResearchFile.js";

async function main(): Promise<void> {
  const keyword = process.argv[2];
  const category = process.argv[3] ?? null;
  if (!keyword) {
    console.log('사용법: npm run debug:gemini-research -- "키워드" [topic]');
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY가 .env에 없습니다.");
    process.exitCode = 1;
    return;
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const prompt = buildGeminiResearchPrompt({
    job: { keyword, headline: null, category },
    baselineSources: [],
    today,
  });

  console.log(`▶ Gemini 호출 중... (keyword: ${keyword})`);
  const result = await runGeminiResearch({ prompt });

  if (!result.ok) {
    console.error(`❌ 실패 (${Math.round(result.durationMs / 1000)}초): ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 응답 수신 (${Math.round(result.durationMs / 1000)}초, ${result.text.length}자)`);
  console.log(`   API가 돌려준 grounding 출처(원시) ${result.groundingSources.length}건`);

  const allowedUrls = new Set(result.groundingSources.map((s) => s.url));
  const enforced = enforceGeminiGroundingUrls(result.text, allowedUrls);
  if (enforced.downgradedCount > 0) {
    console.log(
      `   ⚠️ grounding 미확인 official/medical ${enforced.downgradedCount}건을 community로 강등함(재계산 verdict: ${enforced.recomputedVerdict})`
    );
  } else {
    console.log("   ✅ official/medical 항목 전부 grounding 확인됨(강등 없음)");
  }

  const outputPath = resolve(PIPELINE_ROOT, "research", `${keywordSlug(keyword)}-gemini-smoketest.md`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${enforced.text.trim()}\n`, "utf8");
  console.log(`   저장(강제검증 적용본): ${outputPath}`);

  const parsed = parseResearchFile(enforced.text);
  console.log("\n▶ researcher.md 규격 파싱 결과(강제검증 적용 후)");
  console.log(`   keyword 일치: ${parsed.keyword === keyword ? "✅" : `❌ (파일: "${parsed.keyword}")`}`);
  console.log(`   verdict: ${parsed.verdict}`);
  console.log(`   source_counts: ${JSON.stringify(parsed.sourceCounts)}`);
  console.log(`   §10 출처 표 행 수: ${parsed.sourceTable.length}`);
  console.log(`   §4 미확인 통설: ${parsed.unverifiedClaims.length}건`);
  console.log("\n파일을 열어 researcher.md §9 완료 조건 체크리스트와 직접 대조해보세요.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
