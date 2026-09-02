// Claude 자료조사 vs Gemini 자료조사 A/B 비교. 실제 키워드 1건으로 두 경로를 순서대로 돌려
// research/<슬러그>-compare-claude.md / -compare-gemini.md에 각각 저장하고 요약을 나란히 찍는다.
// article_jobs/DB는 건드리지 않는다 - RESEARCH_PROVIDER 기본값을 gemini로 바꾸기 전 품질 확인용
// 1회성 도구다(runDefaultResearcher가 실제로 쓰는 경로와 동일한 프롬프트 빌더/호출 함수를 그대로
// 재사용하므로, 여기서 본 결과가 곧 실전 결과다).
//
// 사용법:
//   npm run debug:compare-research -- "키워드" [topic]
import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PIPELINE_ROOT, keywordSlug } from "../../config/pipelinePaths.js";
import { buildResearchPrompt } from "./buildResearchPrompt.js";
import { buildGeminiResearchPrompt } from "./buildGeminiResearchPrompt.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { runGeminiResearch } from "../../services/llm/runGeminiResearch.js";
import { parseResearchFile } from "./parseResearchFile.js";
import type { ParsedResearchFile } from "./parseResearchFile.js";

const CLAUDE_RESEARCH_TIMEOUT_MS = 18 * 60 * 1000;

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function printSummary(label: string, durationMs: number, charLength: number, parsed: ParsedResearchFile): void {
  console.log(`\n── ${label} ──`);
  console.log(`   소요: ${Math.round(durationMs / 1000)}초 / 길이: ${charLength}자`);
  console.log(`   verdict: ${parsed.verdict}`);
  console.log(`   source_counts: ${JSON.stringify(parsed.sourceCounts)}`);
  console.log(`   §10 출처 표 행 수: ${parsed.sourceTable.length}`);
  console.log(`   §4 미확인 통설: ${parsed.unverifiedClaims.length}건`);
  console.log(`   §1 요약: ${parsed.summary.slice(0, 200).replace(/\n/g, " ")}${parsed.summary.length > 200 ? "…" : ""}`);
}

async function main(): Promise<void> {
  const keyword = process.argv[2];
  const category = process.argv[3] ?? null;
  if (!keyword) {
    console.log('사용법: npm run debug:compare-research -- "키워드" [topic]');
    return;
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const slug = keywordSlug(keyword);
  const claudePath = resolve(PIPELINE_ROOT, "research", `${slug}-compare-claude.md`);
  const geminiPath = resolve(PIPELINE_ROOT, "research", `${slug}-compare-gemini.md`);
  await mkdir(dirname(claudePath), { recursive: true });

  console.log(`▶ keyword: ${keyword}${category ? ` (topic: ${category})` : ""}`);
  console.log("▶ [1/2] Claude(WebSearch+WebFetch) 실행 중... (수 분 소요될 수 있습니다)");

  const claudeStart = Date.now();
  const claudePrompt = buildResearchPrompt({
    job: { keyword, headline: null, category },
    baselineSources: [],
    outputPath: claudePath,
    today,
  });
  const claudeResult = await runHeadlessClaude({
    prompt: claudePrompt,
    allowedTools: ["Read", "Write", "WebSearch", "WebFetch"],
    permissionMode: "acceptEdits",
    cwd: PIPELINE_ROOT,
    timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
  });
  const claudeDurationMs = Date.now() - claudeStart;

  if (!claudeResult.ok) {
    console.error(`❌ Claude 실패 (${Math.round(claudeDurationMs / 1000)}초): ${claudeResult.error}`);
  } else {
    console.log(`✅ Claude 완료 (${Math.round(claudeDurationMs / 1000)}초)`);
  }

  console.log("\n▶ [2/2] Gemini(Google Search grounding) 실행 중...");
  const geminiStart = Date.now();
  const geminiPrompt = buildGeminiResearchPrompt({ job: { keyword, headline: null, category }, baselineSources: [], today });
  const geminiResult = await runGeminiResearch({ prompt: geminiPrompt });
  const geminiDurationMs = Date.now() - geminiStart;

  if (!geminiResult.ok) {
    console.error(`❌ Gemini 실패 (${Math.round(geminiDurationMs / 1000)}초): ${geminiResult.error}`);
  } else {
    await writeFile(geminiPath, `${stripMarkdownFence(geminiResult.text)}\n`, "utf8");
    console.log(`✅ Gemini 완료 (${Math.round(geminiDurationMs / 1000)}초)`);
  }

  console.log("\n════════════ 비교 요약 ════════════");

  if (claudeResult.ok) {
    const { readFile } = await import("node:fs/promises");
    const claudeText = await readFile(claudePath, "utf8").catch(() => null);
    if (claudeText) {
      printSummary("Claude", claudeDurationMs, claudeText.length, parseResearchFile(claudeText));
    } else {
      console.log(`\n── Claude ── 파일을 못 찾음: ${claudePath}`);
    }
  }

  if (geminiResult.ok) {
    printSummary("Gemini", geminiDurationMs, geminiResult.text.length, parseResearchFile(geminiResult.text));
  }

  console.log(`\n파일 위치:\n  ${claudePath}\n  ${geminiPath}`);
  console.log("researcher.md §9 완료 조건 체크리스트로 직접 대조해보세요.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
