// article_jobs 1건을 조사 -> 원고 생성까지 끝까지 실행하는 오케스트레이션.
//
// 승인 게이트(SPRINT_2_DESIGN.md 10절): 원고 생성은 자동으로 돌지 않는다. 비용이 아직 실측되지
// 않은 상태에서 무인 자동화는 위험하다는 판단으로, 이 함수는 CLI(runArticleJobCli.ts)를 통해
// `npm run job:write -- <jobId>`로 사람이 직접 트리거한다.
//
// 단계마다 status를 전이시키는 이유: 어디서 멈췄는지 DB만 보고 알 수 있어야 한다. Sprint 0에서
// 파이프라인이 조용히 죽었을 때 로그를 열어보고서야 알았던 문제를 반복하지 않는다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { isMedicalTopic } from "../../config/medicalTopicRules.js";
import { createArticleForJob } from "../../services/supabase/repositories/articleRepository.js";
import { createSources } from "../../services/supabase/repositories/sourceRepository.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { collectSourcesForJob } from "../research/collectSourcesForJob.js";
import { enrichOfficialSources } from "../research/fetchOfficialSourceContent.js";
import { buildArticlePrompt, parseArticleOutput } from "./buildArticlePrompt.js";
import type { ArticleJobRow, ArticleRow, SourceRow } from "../../types/database.js";

/** 원고 생성은 제목 생성(25초 실측)보다 훨씬 길다. 첫 실측 전까지는 넉넉하게 잡는다. */
export const WRITE_TIMEOUT_MS = 10 * 60 * 1000;

/** 이미 결정이 끝난 job은 재실행하지 않는다 - 재실행하면 승인된/발행된 원고 위에 새 원고가 덮어써진다. */
const NON_RETRYABLE_STATUSES: ArticleJobRow["status"][] = ["review", "approved", "published", "rejected"];

/** runHeadlessClaude 결과와 호환되는 최소 형태. 테스트 주입이 durationMs 없이도 넘길 수 있게 한다. */
export type GenerateArticleResult = { ok: true; output: string } | { ok: false; error: string };

export type RunArticleJobOptions = {
  /** 공공 도메인 본문 fetch를 건너뛴다(테스트/디버그용). 기본 활성화. */
  fetchOfficialContent?: boolean;
  /** 테스트에서 실제 LLM 호출을 대체하는 주입 지점. */
  generateArticle?: (prompt: string) => Promise<GenerateArticleResult>;
};

export type RunArticleJobResult =
  | {
      status: "success";
      job: ArticleJobRow;
      article: ArticleRow;
      sources: SourceRow[];
      isMedical: boolean;
      requiresMedicalReview: boolean;
      durationMs: { research: number; writing: number };
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; stage: "research" | "writing"; error: string };

export async function runArticleJob(
  jobId: string,
  options: RunArticleJobOptions = {}
): Promise<RunArticleJobResult> {
  const job = await ArticleJobRepository.findById(jobId);
  if (!job) return { status: "skipped", reason: `job을 찾을 수 없습니다: ${jobId}` };

  if (NON_RETRYABLE_STATUSES.includes(job.status)) {
    return { status: "skipped", reason: `이미 처리된 job입니다 (상태: ${job.status})` };
  }

  // ---------- 1) 자료조사 ----------
  const researchStartedAt = Date.now();
  await ArticleJobRepository.updateStatus(jobId, "researching");

  const research = await collectSourcesForJob(jobId, job.keyword);
  if (research.sources.length === 0) {
    const error = Object.entries(research.sourceErrors)
      .map(([source, message]) => `${source}: ${message}`)
      .join(" / ") || "검색 결과가 비어 있습니다.";
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[research] ${error}` });
    // status는 되돌리지 않는다(researching 유지) - 재실행 시 이 job을 다시 집을 수 있어야 한다.
    return { status: "failed", stage: "research", error };
  }

  let enriched = research.sources;
  if (options.fetchOfficialContent !== false) {
    const result = await enrichOfficialSources(research.sources);
    enriched = result.sources;
    if (result.enrichedCount > 0 || result.rejectedCount > 0) {
      console.log(
        `ℹ️ [research] official 본문 fetch: 교체 ${result.enrichedCount}건, 산문 아님(스니펫 유지) ${result.rejectedCount}건`
      );
    }
  }
  const savedSources = await createSources(enriched);
  const researchDurationMs = Date.now() - researchStartedAt;

  // ---------- 2) 원고 생성 ----------
  const writingStartedAt = Date.now();
  await ArticleJobRepository.updateStatus(jobId, "writing");

  // headline도 함께 본다 - 키워드가 짧게 정제돼 의학 어휘가 빠졌더라도 원문 제목에는 남아 있을 수 있다.
  const isMedical = isMedicalTopic(job.keyword) || (job.headline ? isMedicalTopic(job.headline) : false);

  const prompt = buildArticlePrompt({ job, sources: savedSources, isMedical });

  const generate: (prompt: string) => Promise<GenerateArticleResult> =
    options.generateArticle ??
    (async (p: string) => {
      const result = await runHeadlessClaude({ prompt: p, allowedTools: ["Skill"], timeoutMs: WRITE_TIMEOUT_MS });
      return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.error };
    });

  const generated = await generate(prompt);
  const writingDurationMs = Date.now() - writingStartedAt;

  if (!generated.ok) {
    const error = generated.error;
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[writing] ${error}` });
    // status는 되돌리지 않는다(writing 유지) - 이미 모은 sources는 재사용할 수 있다.
    return { status: "failed", stage: "writing", error };
  }

  const parsed = parseArticleOutput(generated.output, job.keyword);

  const article = await createArticleForJob({
    job_id: jobId,
    title: parsed.title,
    content: parsed.body,
    status: "review",
    ai_model: "claude-headless(content-blog+korean-humanize)",
  });

  await ArticleJobRepository.mergeMetadata(jobId, {
    seoDescription: parsed.seoDescription,
    isMedical,
    requiresMedicalReview: isMedical,
    sourceCounts: {
      total: savedSources.length,
      official: savedSources.filter((s) => s.authority === "official").length,
      medical: savedSources.filter((s) => s.authority === "medical").length,
      news: savedSources.filter((s) => s.authority === "news").length,
      community: savedSources.filter((s) => s.authority === "community").length,
    },
  });
  const updatedJob = await ArticleJobRepository.updateStatus(jobId, "review");

  return {
    status: "success",
    job: updatedJob ?? job,
    article,
    sources: savedSources,
    isMedical,
    requiresMedicalReview: isMedical,
    durationMs: { research: researchDurationMs, writing: writingDurationMs },
  };
}
