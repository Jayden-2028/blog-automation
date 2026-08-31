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

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { ARTICLE_IMAGE_GENERATION_ENABLED } from "../../config/articleImages.js";
import { isMedicalTopic } from "../../config/medicalTopicRules.js";
import { PIPELINE_ROOT, researchFilePath } from "../../config/pipelinePaths.js";
import { createArticleForJob } from "../../services/supabase/repositories/articleRepository.js";
import { createSources, listSourcesByJobId } from "../../services/supabase/repositories/sourceRepository.js";
import { createImage } from "../../services/supabase/repositories/imageRepository.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { publishArticleToTelegraph } from "../../services/telegraph/telegraphClient.js";
import { collectSourcesForJob } from "../research/collectSourcesForJob.js";
import { enrichOfficialSources } from "../research/fetchOfficialSourceContent.js";
import { buildResearchPrompt } from "../research/buildResearchPrompt.js";
import { parseResearchFile } from "../research/parseResearchFile.js";
import type { ResearchVerdict } from "../research/parseResearchFile.js";
import { buildArticlePrompt, buildMedicalDisclaimer, parseArticleOutput } from "./buildArticlePrompt.js";
import { generateArticleImages } from "./generateArticleImages.js";
import type { GenerateArticleImagesResult } from "./generateArticleImages.js";
import { runArticleReview } from "../review/runArticleReview.js";
import type { ArticleReviewResult } from "../review/runArticleReview.js";
import type { ArticleJobRow, ArticleRow, SourceAuthorityLevel, SourceInsert, SourceRow } from "../../types/database.js";

/** 원고 생성은 제목 생성(25초 실측)보다 훨씬 길다. 첫 실측(185초)의 3배 이상 여유를 둔다. */
export const WRITE_TIMEOUT_MS = 10 * 60 * 1000;

/** 이미 결정이 끝난 job은 재실행하지 않는다 - 재실행하면 승인된/발행된 원고 위에 새 원고가 덮어써진다. */
const NON_RETRYABLE_STATUSES: ArticleJobRow["status"][] = ["review", "approved", "published", "rejected"];

/** runHeadlessClaude 결과와 호환되는 최소 형태. 테스트 주입이 durationMs 없이도 넘길 수 있게 한다. */
export type GenerateArticleResult = { ok: true; output: string } | { ok: false; error: string };

// ---------- 1단계: 자료조사 ----------

/** researcher 에이전트는 WebSearch를 여러 번 돌리고 URL을 연다 - 원고 생성보다도 길게 잡는다. */
export const RESEARCH_TIMEOUT_MS = 18 * 60 * 1000;

export type RunResearchStageOptions = {
  /** 공공 도메인 본문 fetch를 건너뛴다(테스트/디버그용). 기본 활성화. */
  fetchOfficialContent?: boolean;
  /** 테스트 주입: 헤드리스 researcher 실행을 대체한다. */
  runResearcher?: (prompt: string, outputPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 테스트 주입: research 파일 읽기를 대체한다. */
  readResearchFile?: (path: string) => Promise<string | null>;
};

export type RunResearchStageResult =
  | {
      status: "success";
      job: ArticleJobRow;
      sources: SourceRow[];
      researchFilePath: string;
      verdict: ResearchVerdict;
      sourceCounts: Record<SourceAuthorityLevel, number>;
      durationMs: number;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

async function defaultRunResearcher(
  prompt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runHeadlessClaude({
    prompt,
    allowedTools: ["Read", "Write", "WebSearch", "WebFetch"],
    permissionMode: "acceptEdits",
    cwd: PIPELINE_ROOT,
    timeoutMs: RESEARCH_TIMEOUT_MS,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function defaultReadResearchFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

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

  // 1) 기준 자료(baseline) - NAVER 검색 API. 하이브리드의 감사 베이스라인이다. 비어 있어도
  //    바로 실패하지 않는다 - 에이전트가 WebSearch로 채울 수 있다(단, 그 사실을 프롬프트에 알린다).
  const collected = await collectSourcesForJob(jobId, job.keyword);
  let baseline = collected.sources;
  if (options.fetchOfficialContent !== false && baseline.length > 0) {
    const result = await enrichOfficialSources(baseline);
    baseline = result.sources;
    if (result.enrichedCount > 0 || result.rejectedCount > 0) {
      console.log(
        `ℹ️ [research] official 본문 fetch: 교체 ${result.enrichedCount}건, 산문 아님(스니펫 유지) ${result.rejectedCount}건`
      );
    }
  }
  const savedBaseline = await createSources(baseline);
  if (savedBaseline.length === 0) {
    const errText = Object.entries(collected.sourceErrors)
      .map(([source, message]) => `${source}: ${message}`)
      .join(" / ");
    console.warn(`⚠️ [research] baseline이 비었습니다 (${errText || "검색 결과 없음"}) - 에이전트가 전부 조사합니다.`);
  }

  // 2) 헤드리스 researcher 에이전트 - researcher.md 계약대로 조사해 research/<슬러그>.md를 쓴다.
  const outputPath = researchFilePath(job.keyword);
  await mkdir(dirname(outputPath), { recursive: true });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const prompt = buildResearchPrompt({ job, baselineSources: baseline, outputPath, today });

  const runResearcher = options.runResearcher ?? ((p) => defaultRunResearcher(p));
  const ran = await runResearcher(prompt, outputPath);
  if (!ran.ok) {
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[research] ${ran.error}` });
    // status는 되돌리지 않는다(researching 유지) - 재실행 시 이 job을 다시 집을 수 있어야 한다.
    return { status: "failed", error: ran.error };
  }

  // 3) 산출 파일 읽기 + 파싱
  const readResearchFile = options.readResearchFile ?? defaultReadResearchFile;
  const fileText = await readResearchFile(outputPath);
  if (!fileText || fileText.trim().length === 0) {
    const error = `researcher가 파일을 만들지 않았습니다: ${outputPath}`;
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[research] ${error}` });
    return { status: "failed", error };
  }
  const parsed = parseResearchFile(fileText);

  // 4) §10 출처 표에서 baseline에 없던 URL을 sources에 추가한다(감사기록 유지 - Sprint 3 검수가
  //    본문 사실을 sources와 대조한다).
  const baselineUrls = new Set(savedBaseline.map((s) => s.url).filter(Boolean) as string[]);
  const agentSources: SourceInsert[] = parsed.sourceTable
    .filter((row) => row.url && /^https?:\/\//.test(row.url) && !baselineUrls.has(row.url))
    .map((row) => ({
      job_id: jobId,
      title: row.title,
      url: row.url,
      source_name: "researcher",
      authority: row.authority,
      published_at: row.publishedAt,
      content: null,
    }));
  const savedAgent = agentSources.length > 0 ? await createSources(dedupeSourceInserts(agentSources)) : [];

  const allSources = [...savedBaseline, ...savedAgent];
  const sourceCounts: Record<SourceAuthorityLevel, number> = {
    official: allSources.filter((s) => s.authority === "official").length,
    medical: allSources.filter((s) => s.authority === "medical").length,
    news: allSources.filter((s) => s.authority === "news").length,
    community: allSources.filter((s) => s.authority === "community").length,
  };

  await ArticleJobRepository.mergeMetadata(jobId, {
    lastError: null,
    researchFilePath: outputPath,
    researchVerdict: parsed.verdict,
    sourceCounts,
  });

  return {
    status: "success",
    job,
    sources: allSources,
    researchFilePath: outputPath,
    verdict: parsed.verdict,
    sourceCounts,
    durationMs: Date.now() - startedAt,
  };
}

/** url(없으면 title) 기준 중복 제거. createSources 전에 배치 내부 중복을 막는다. */
function dedupeSourceInserts(items: SourceInsert[]): SourceInsert[] {
  const seen = new Set<string>();
  const out: SourceInsert[] = [];
  for (const item of items) {
    const key = item.url ?? `no-url:${item.title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---------- 2단계: 원고 생성 ----------

export type RunWritingStageOptions = {
  /** 테스트에서 실제 LLM 호출을 대체하는 주입 지점. */
  generateArticle?: (prompt: string) => Promise<GenerateArticleResult>;
  /** 이미 조사된 근거를 넘기면 재수집하지 않는다. 생략하면 DB에서 먼저 찾고, 없으면 조사부터 한다. */
  sources?: SourceRow[];
  /** sources 생략 시 내부에서 runResearchStage를 호출할 때 전달할 옵션. */
  researchOptions?: RunResearchStageOptions;
  /** false로 주면 이미지 생성을 건너뛴다(테스트, 또는 비용을 아끼고 싶을 때). 기본은 생성한다. */
  generateImages?: boolean;
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
      /** 검수 규칙 4종 결과(SPRINT_3_DESIGN.md). 차단하지 않는다 - 사람이 참고만 한다. */
      review: ArticleReviewResult;
      /**
       * 생성 성공/실패 개수(2026-08-28). `held`면 자동생성 보류 상태라 본문에 `[IMAGE:]` 마커가
       * 그대로 남아 있고 사용자가 직접 이미지를 삽입해야 한다(2026-09-01, CLAUDE.md 운영 규칙).
       */
      images: { succeeded: number; failed: number; held: boolean };
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

  // 이미지 자동 생성 + 본문 삽입(2026-08-28). 2026-09-01부터 기본 보류(CLAUDE.md 원고 파이프라인
  // 운영 규칙): 시스템 안정화 전까지 유료 이미지 API 호출을 피한다. 보류 상태에서는 본문의
  // `[IMAGE: 설명]` 마커를 그대로 두고(passthrough) 사용자가 직접 이미지를 만들어 삽입한다.
  // 재개는 .env `ARTICLE_IMAGE_GENERATION=true`. 생성/삽입 코드 자체는 그대로 살아 있다.
  // 실패해도 원고 텍스트는 이미 완성돼 있으므로 계속 진행한다(generateArticleImages는 예외를
  // 던지지 않고 failures 배열로만 알린다).
  const imageGenerationHeld = !ARTICLE_IMAGE_GENERATION_ENABLED;
  const imageGeneration: GenerateArticleImagesResult =
    options.generateImages === false || imageGenerationHeld
      ? { body: parsed.body, images: [], failures: [] }
      : await generateArticleImages({
          jobId,
          title: parsed.title,
          keyword: job.keyword,
          category: job.category,
          seoDescription: parsed.seoDescription,
          body: parsed.body,
        });
  if (imageGeneration.failures.length > 0) {
    console.error(`⚠️ 이미지 ${imageGeneration.failures.length}건 생성 실패 (원고는 계속 진행) -`, imageGeneration.failures.join(" / "));
  }

  // 최종 본문 = (이미지 삽입된) body + 해시태그 한 줄 + (의학 주제면) 출처 신뢰도 고지.
  // 해시태그/고지를 body에 직접 섞지 않고 여기서 결정적으로 붙이는 이유(2026-08-28, 사용자 요청):
  // 둘 다 "매번 정확히 지켜져야 하는" 항목이라 모델 출력에만 맡기면 빠뜨릴 수 있다.
  // buildMedicalDisclaimer()는 실제 sources 등급을 보고 문구를 정하므로 모델이 지어낼 수 없다.
  const disclaimer = buildMedicalDisclaimer(isMedical, sources);
  const content = [imageGeneration.body, parsed.hashtags.length > 0 ? parsed.hashtags.join(" ") : null, disclaimer]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  const article = await createArticleForJob({
    job_id: jobId,
    title: parsed.title,
    content,
    status: "review",
    ai_model: "claude-headless(content-blog+korean-humanize)",
  });

  // 생성된 이미지를 images 테이블에 기록한다(article.id가 생긴 뒤에만 가능하다).
  // 실패해도 원고 저장 자체를 막지 않는다 - 이미지가 본문에는 이미 들어가 있으므로 기록 실패는
  // 사후에 job:image로 보완할 수 있다.
  for (const image of imageGeneration.images) {
    try {
      await createImage({
        article_id: article.id,
        image_url: image.imageUrl,
        source: image.provider,
        copyright_status: image.copyrightStatus,
        alt_text: image.altText,
      });
    } catch (error) {
      console.error(`⚠️ 이미지 기록 실패(본문에는 이미 삽입됨) -`, error instanceof Error ? error.message : error);
    }
  }

  // 검수 4종을 돌린다(SPRINT_3_DESIGN.md 3절). runWritingStage 안에서 자동으로 실행하는 이유는
  // 규칙 기반이라 비용이 사실상 0이고, 결과가 곧 알림 내용의 일부이기 때문이다 - 조사 체크포인트처럼
  // 별도 CLI 단계로 분리하면 사람이 명령을 한 번 더 쳐야 하는데 그 대가로 얻는 게 없다.
  // ⚠️ 이 결과는 원고를 차단하지 않는다 - 알림에 표시되고 사람이 판단한다.
  const review = runArticleReview({
    job: { category: job.category },
    article: { title: article.title, content: article.content, created_at: article.created_at },
    sources: sources.map((s) => ({ content: s.content })),
    hashtags: parsed.hashtags,
    isMedical,
  });

  // Telegraph 발행은 "더 잘 읽히게" 하는 부가 단계다 - 실패해도 원고 생성 자체는 성공으로
  // 취급한다(publishArticleToTelegraph는 예외를 던지지 않고 ok:false를 돌려준다).
  // ⚠️ Telegraph 페이지는 URL을 아는 누구나 볼 수 있는 공개 페이지다. 검수 전 원고가 이 URL로
  // 노출된다는 뜻이라, 사람 확인 전에 발행하는 지금 방식은 트레이드오프를 감수한 것이다
  // (2026-08-27 사용자 승인).
  const telegraphResult = await publishArticleToTelegraph(article.title ?? job.keyword, content);
  const telegraphUrl = telegraphResult.ok ? telegraphResult.url : null;
  if (!telegraphResult.ok) {
    console.error(`⚠️ Telegraph 발행 실패 (Telegram 본문 dump로 폴백) -`, telegraphResult.error);
  }

  await ArticleJobRepository.mergeMetadata(jobId, {
    seoDescription: parsed.seoDescription,
    hashtags: parsed.hashtags,
    isMedical,
    requiresMedicalReview: isMedical,
    telegraphUrl,
    // 새 테이블(review_checks) 대신 metadata에 저장한다(설계 7절 결정) - migration 수동 적용
    // 부담을 지금 질 이유가 없고, 하루 1~2건 규모에서는 JSON 연산자로 충분히 분석할 수 있다.
    reviewChecks: review.checks,
    imageCounts: { succeeded: imageGeneration.images.length, failed: imageGeneration.failures.length },
    imageFailures: imageGeneration.failures,
    imageGenerationHeld,
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
    review,
    images: {
      succeeded: imageGeneration.images.length,
      failed: imageGeneration.failures.length,
      held: imageGenerationHeld,
    },
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
      telegraphUrl: string | null;
      review: ArticleReviewResult;
      images: { succeeded: number; failed: number; held: boolean };
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
    telegraphUrl: writing.telegraphUrl,
    review: writing.review,
    images: writing.images,
  };
}
