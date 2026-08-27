// article_jobs 1건을 조사 -> 원고 생성까지 실행하는 오케스트레이션.
// runResearchStage와 runWritingStage로 나뉘어 있고, runArticleJob은 둘을 이어 붙인 편의 함수다.
//
// 왜 나눴는가(2026-08-27, 사용자 피드백): 첫 실측(경복궁 별빛야행)에서 원고 자체는 프롬프트
// 규칙대로 정확했지만, 수집된 근거에 "이미 마감된 이벤트"라는 핵심 정보가 있었는데도 3분 분량의
// LLM 비용을 쓴 뒤에야 그 사실을 알게 됐다. 이건 원고 품질 문제가 아니라 "애초에 쓸 가치가 있는
// 키워드인가"를 조사 직후에 사람이 판단할 기회가 없었던 문제다. 그래서 조사(research)와
// 작성(writing) 사이에 사람이 끼어들 수 있는 지점을 만든다:
//
//   npm run job:research -- <jobId>   조사만 하고 팩트 카드를 Telegram으로 보낸 뒤 멈춘다
//   (사람이 확인 후)
//   npm run job:write -- <jobId>      이미 조사된 sources가 있으면 재수집하지 않고 바로 작성한다
//   npm run job:reject -- <jobId>     조사 결과를 보고 가치가 없다고 판단하면 여기서 끝낸다
//
// runArticleJob(jobId)를 그냥 호출하면(체크포인트를 건너뛰고 싶을 때) 예전과 동일하게 조사 ->
// 작성을 한 번에 실행한다 - 이 함수는 내부적으로 runResearchStage + runWritingStage를 그대로
// 이어 붙인 것뿐이다.
//
// 승인 게이트(SPRINT_2_DESIGN.md 10절): 작성 단계는 자동으로 돌지 않는다. 비용이 아직
// 실측되지 않은 상태에서 무인 자동화는 위험하다는 판단으로, 사람이 CLI로 직접 트리거한다.
//
// 단계마다 status를 전이시키는 이유: 어디서 멈췄는지 DB만 보고 알 수 있어야 한다. Sprint 0에서
// 파이프라인이 조용히 죽었을 때 로그를 열어보고서야 알았던 문제를 반복하지 않는다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { isMedicalTopic } from "../../config/medicalTopicRules.js";
import { createArticleForJob } from "../../services/supabase/repositories/articleRepository.js";
import { createSources, listSourcesByJobId } from "../../services/supabase/repositories/sourceRepository.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { publishArticleToTelegraph } from "../../services/telegraph/telegraphClient.js";
import { collectSourcesForJob } from "../research/collectSourcesForJob.js";
import { enrichOfficialSources } from "../research/fetchOfficialSourceContent.js";
import { buildArticlePrompt, parseArticleOutput } from "./buildArticlePrompt.js";
import type { ArticleJobRow, ArticleRow, SourceRow } from "../../types/database.js";

/** 원고 생성은 제목 생성(25초 실측)보다 훨씬 길다. 첫 실측(185초)의 3배 이상 여유를 둔다. */
export const WRITE_TIMEOUT_MS = 10 * 60 * 1000;

/** 이미 결정이 끝난 job은 재실행하지 않는다 - 재실행하면 승인된/발행된 원고 위에 새 원고가 덮어써진다. */
const NON_RETRYABLE_STATUSES: ArticleJobRow["status"][] = ["review", "approved", "published", "rejected"];

/** runHeadlessClaude 결과와 호환되는 최소 형태. 테스트 주입이 durationMs 없이도 넘길 수 있게 한다. */
export type GenerateArticleResult = { ok: true; output: string } | { ok: false; error: string };

// ---------- 1단계: 자료조사 ----------

export type RunResearchStageOptions = {
  /** 공공 도메인 본문 fetch를 건너뛴다(테스트/디버그용). 기본 활성화. */
  fetchOfficialContent?: boolean;
};

export type RunResearchStageResult =
  | { status: "success"; job: ArticleJobRow; sources: SourceRow[]; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export async function runResearchStage(
  jobId: string,
  options: RunResearchStageOptions = {}
): Promise<RunResearchStageResult> {
  const job = await ArticleJobRepository.findById(jobId);
  if (!job) return { status: "skipped", reason: `job을 찾을 수 없습니다: ${jobId}` };

  if (NON_RETRYABLE_STATUSES.includes(job.status)) {
    return { status: "skipped", reason: `이미 처리된 job입니다 (상태: ${job.status})` };
  }

  const startedAt = Date.now();
  await ArticleJobRepository.updateStatus(jobId, "researching");

  const research = await collectSourcesForJob(jobId, job.keyword);
  if (research.sources.length === 0) {
    const error =
      Object.entries(research.sourceErrors)
        .map(([source, message]) => `${source}: ${message}`)
        .join(" / ") || "검색 결과가 비어 있습니다.";
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[research] ${error}` });
    // status는 되돌리지 않는다(researching 유지) - 재실행 시 이 job을 다시 집을 수 있어야 한다.
    return { status: "failed", error };
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
  return { status: "success", job, sources: savedSources, durationMs: Date.now() - startedAt };
}

// ---------- 2단계: 원고 생성 ----------

export type RunWritingStageOptions = {
  /** 테스트에서 실제 LLM 호출을 대체하는 주입 지점. */
  generateArticle?: (prompt: string) => Promise<GenerateArticleResult>;
  /** 이미 조사된 근거를 넘기면 재수집하지 않는다. 생략하면 DB에서 먼저 찾고, 없으면 조사부터 한다. */
  sources?: SourceRow[];
  /** sources 생략 시 내부에서 runResearchStage를 호출할 때 전달할 옵션. */
  researchOptions?: RunResearchStageOptions;
};

export type RunWritingStageResult =
  | {
      status: "success";
      job: ArticleJobRow;
      article: ArticleRow;
      sources: SourceRow[];
      isMedical: boolean;
      requiresMedicalReview: boolean;
      durationMs: number;
      /** Telegraph 발행 URL. 발행이 실패해도(네트워크 등) 원고 자체는 성공으로 취급하므로 null일 수 있다. */
      telegraphUrl: string | null;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export async function runWritingStage(
  jobId: string,
  options: RunWritingStageOptions = {}
): Promise<RunWritingStageResult> {
  const job = await ArticleJobRepository.findById(jobId);
  if (!job) return { status: "skipped", reason: `job을 찾을 수 없습니다: ${jobId}` };

  if (NON_RETRYABLE_STATUSES.includes(job.status)) {
    return { status: "skipped", reason: `이미 처리된 job입니다 (상태: ${job.status})` };
  }

  // 근거 확보: 주입된 것 -> DB에 이미 저장된 것(job:research를 먼저 돌린 경우) -> 없으면 지금 조사한다.
  // 이 순서 덕분에 runWritingStage 하나만 불러도(=runArticleJob) 여전히 원샷으로 동작하고,
  // job:research를 먼저 돌린 경우엔 같은 검색을 두 번 하지 않는다(중복 sources row 방지).
  let sources = options.sources;
  if (!sources) {
    const existing = await listSourcesByJobId(jobId);
    if (existing.length > 0) {
      sources = existing;
    } else {
      const research = await runResearchStage(jobId, options.researchOptions);
      if (research.status !== "success") {
        return research.status === "skipped"
          ? research
          : { status: "failed", error: `[research] ${research.error}` };
      }
      sources = research.sources;
    }
  }

  const startedAt = Date.now();
  await ArticleJobRepository.updateStatus(jobId, "writing");

  // headline도 함께 본다 - 키워드가 짧게 정제돼 의학 어휘가 빠졌더라도 원문 제목에는 남아 있을 수 있다.
  const isMedical = isMedicalTopic(job.keyword) || (job.headline ? isMedicalTopic(job.headline) : false);

  const prompt = buildArticlePrompt({ job, sources, isMedical });

  const generate: (prompt: string) => Promise<GenerateArticleResult> =
    options.generateArticle ??
    (async (p: string) => {
      const result = await runHeadlessClaude({ prompt: p, allowedTools: ["Skill"], timeoutMs: WRITE_TIMEOUT_MS });
      return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.error };
    });

  const generated = await generate(prompt);
  const durationMs = Date.now() - startedAt;

  if (!generated.ok) {
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[writing] ${generated.error}` });
    // status는 되돌리지 않는다(writing 유지) - 이미 모은 sources는 재사용할 수 있다.
    return { status: "failed", error: generated.error };
  }

  const parsed = parseArticleOutput(generated.output, job.keyword);

  const article = await createArticleForJob({
    job_id: jobId,
    title: parsed.title,
    content: parsed.body,
    status: "review",
    ai_model: "claude-headless(content-blog+korean-humanize)",
  });

  // Telegraph 발행은 "더 잘 읽히게" 하는 부가 단계다 - 실패해도 원고 생성 자체는 성공으로
  // 취급한다(publishArticleToTelegraph는 예외를 던지지 않고 ok:false를 돌려준다).
  // ⚠️ Telegraph 페이지는 URL을 아는 누구나 볼 수 있는 공개 페이지다. 검수 전 원고가 이 URL로
  // 노출된다는 뜻이라, 사람 확인 전에 발행하는 지금 방식은 트레이드오프를 감수한 것이다
  // (2026-08-27 사용자 승인).
  const telegraphResult = await publishArticleToTelegraph(article.title ?? job.keyword, parsed.body);
  const telegraphUrl = telegraphResult.ok ? telegraphResult.url : null;
  if (!telegraphResult.ok) {
    console.error(`⚠️ Telegraph 발행 실패 (Telegram 본문 dump로 폴백) -`, telegraphResult.error);
  }

  await ArticleJobRepository.mergeMetadata(jobId, {
    seoDescription: parsed.seoDescription,
    isMedical,
    requiresMedicalReview: isMedical,
    telegraphUrl,
    sourceCounts: {
      total: sources.length,
      official: sources.filter((s) => s.authority === "official").length,
      medical: sources.filter((s) => s.authority === "medical").length,
      news: sources.filter((s) => s.authority === "news").length,
      community: sources.filter((s) => s.authority === "community").length,
    },
  });
  const updatedJob = await ArticleJobRepository.updateStatus(jobId, "review");

  return {
    status: "success",
    job: updatedJob ?? job,
    article,
    sources,
    isMedical,
    telegraphUrl,
    requiresMedicalReview: isMedical,
    durationMs,
  };
}

// ---------- 편의 함수: 조사 + 작성을 한 번에 ----------

export type RunArticleJobOptions = RunResearchStageOptions & Pick<RunWritingStageOptions, "generateArticle">;

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

/** 체크포인트를 쓰지 않고 조사 -> 작성을 곧바로 이어 실행한다. */
export async function runArticleJob(
  jobId: string,
  options: RunArticleJobOptions = {}
): Promise<RunArticleJobResult> {
  const research = await runResearchStage(jobId, { fetchOfficialContent: options.fetchOfficialContent });
  if (research.status !== "success") {
    return research.status === "skipped" ? research : { status: "failed", stage: "research", error: research.error };
  }

  const writing = await runWritingStage(jobId, {
    sources: research.sources,
    generateArticle: options.generateArticle,
  });
  if (writing.status !== "success") {
    return writing.status === "skipped" ? writing : { status: "failed", stage: "writing", error: writing.error };
  }

  return {
    status: "success",
    job: writing.job,
    article: writing.article,
    sources: writing.sources,
    isMedical: writing.isMedical,
    requiresMedicalReview: writing.requiresMedicalReview,
    durationMs: { research: research.durationMs, writing: writing.durationMs },
  };
}
