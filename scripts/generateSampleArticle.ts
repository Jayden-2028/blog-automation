// 한 주제로 네이버(기준)·티스토리·블로그스팟용 샘플 원고 3종을 만든다.
// 실제 프로덕션 경로와 같은 스킬을 쓴다:
//   - 기준 원고: NAVER 검색 자료조사 → buildArticlePrompt → claude -p
//     (moai-marketer:content-blog + moai-writer:korean-humanize)
//   - 티스토리/블로그스팟: generateArticleVariant (같은 스킬 + 채널 SEO)
//
// DB에 아무것도 쓰지 않는다(job/sources/article row 안 만듦). 이미지도 생성하지 않는다.
// 결과는 .local/sample-articles/<slug>/ 에 마크다운으로.
//
// 실행: npx tsx scripts/generateSampleArticle.ts "<키워드>" [category]
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

import { isMedicalTopic } from "../src/config/medicalTopicRules.js";
import { runHeadlessClaude } from "../src/services/llm/runHeadlessClaude.js";
import { collectSourcesForJob } from "../src/workflows/research/collectSourcesForJob.js";
import { enrichOfficialSources } from "../src/workflows/research/fetchOfficialSourceContent.js";
import { buildArticlePrompt, parseArticleOutput } from "../src/workflows/writing/buildArticlePrompt.js";
import { generateArticleVariant } from "../src/workflows/writing/generateArticleVariant.js";
import type { ArticleJobRow, SourceRow } from "../src/types/database.js";

const WRITE_TIMEOUT_MS = 10 * 60 * 1000;

function slugify(s: string): string {
  return s.trim().replace(/\s+/g, "-").replace(/[^\w가-힣-]/g, "").slice(0, 40);
}

async function main(): Promise<void> {
  const keyword = process.argv[2];
  const category = process.argv[3] ?? "entertainment";
  if (!keyword) {
    console.error('사용법: npx tsx scripts/generateSampleArticle.ts "<키워드>" [category]');
    process.exit(1);
  }

  const dir = `.local/sample-articles/${slugify(keyword)}`;
  mkdirSync(dir, { recursive: true });
  console.log(`▶ 주제: "${keyword}" (category=${category})\n`);

  // 1) 자료조사 (실제 NAVER 검색)
  console.log("1) NAVER 뉴스/웹/블로그 검색 중...");
  const research = await collectSourcesForJob("sample", keyword, { displayPerSource: 6 });
  if (research.sources.length === 0) {
    console.error("검색 결과가 비어 있습니다:", JSON.stringify(research.sourceErrors));
    process.exit(1);
  }
  const { sources: enriched } = await enrichOfficialSources(research.sources);
  const sources = enriched as unknown as SourceRow[];
  console.log(`   근거 ${sources.length}건`);
  writeFileSync(
    `${dir}/00-sources.md`,
    `# 자료조사: ${keyword}\n\n` +
      sources
        .map(
          (s, i) =>
            `${i + 1}. [${s.authority ?? "미분류"}] ${s.title ?? "(제목없음)"}\n   ${s.url ?? ""}\n   ${(s.content ?? "").slice(0, 200)}`
        )
        .join("\n\n"),
    "utf-8"
  );

  // 2) 기준 원고(네이버용) - buildArticlePrompt + claude -p
  const job: ArticleJobRow = {
    id: "sample",
    source_run_id: 0,
    source_rank: 0,
    keyword,
    headline: keyword,
    seed_query: null,
    category,
    total_score: null,
    score_breakdown: null,
    status: "writing",
    selected_at: new Date().toISOString(),
    selected_via: "manual",
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ArticleJobRow;

  const isMedical = isMedicalTopic(keyword);
  console.log(`\n2) 기준 원고(네이버용) 생성 중 (claude -p, 수 분)...`);
  const started = Date.now();
  const result = await runHeadlessClaude({
    prompt: buildArticlePrompt({ job, sources, isMedical }),
    allowedTools: ["Skill"],
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!result.ok) {
    console.error("기준 원고 생성 실패:", result.error);
    process.exit(1);
  }
  const base = parseArticleOutput(result.output, keyword);
  console.log(`   ${Math.round((Date.now() - started) / 1000)}초, 제목: "${base.title}", 본문 ${base.body.length}자`);
  writeFileSync(
    `${dir}/01-naver-base.md`,
    `# ${base.title}\n\n> 네이버 기준 원고 · SEO설명: ${base.seoDescription ?? "-"}\n> 해시태그: ${base.hashtags.join(" ")}\n\n---\n\n${base.body}`,
    "utf-8"
  );

  // 3) 티스토리 / 블로그스팟 배리에이션
  for (const channel of ["tistory", "blogspot"] as const) {
    console.log(`\n3) ${channel} 배리에이션 생성 중 (claude -p, 수 분)...`);
    const t0 = Date.now();
    const v = await generateArticleVariant({ channel, category, baseTitle: base.title, baseBody: base.body });
    if (v.status !== "success") {
      console.error(`   ${channel} 실패:`, v.error);
      continue;
    }
    console.log(`   ${Math.round((Date.now() - t0) / 1000)}초, 제목: "${v.variant.title}", 본문 ${v.variant.body.length}자, 태그 ${v.variant.tags.length}개`);
    writeFileSync(
      `${dir}/02-${channel}.md`,
      `# ${v.variant.title}\n\n> ${channel} 배리에이션` +
        `\n> slug: ${v.variant.slug ?? "-"}` +
        `\n> searchDescription: ${v.variant.searchDescription ?? "-"}` +
        `\n> tags: ${v.variant.tags.join(", ")}\n\n---\n\n${v.variant.body}`,
      "utf-8"
    );
  }

  console.log(`\n✅ 완료 -> ${dir}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
