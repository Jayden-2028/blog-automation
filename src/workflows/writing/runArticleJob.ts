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

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { ARTICLE_IMAGE_GENERATION_ENABLED } from "../../config/articleImages.js";
import { isMedicalTopic } from "../../config/medicalTopicRules.js";
import { PIPELINE_ROOT, draftFilePath, researchFilePath } from "../../config/pipelinePaths.js";
import { RESEARCH_PROVIDER, RESEARCH_FALLBACK_TO_CLAUDE } from "../../config/researchProvider.js";
import { createArticleForJob } from "../../services/supabase/repositories/articleRepository.js";
import { createSources, listSourcesByJobId } from "../../services/supabase/repositories/sourceRepository.js";
import { createImage } from "../../services/supabase/repositories/imageRepository.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { runGeminiResearch } from "../../services/llm/runGeminiResearch.js";
import { recordApiUsage } from "../../services/usage/recordApiUsage.js";
import { runWithHeavyPipelineLock } from "../../jobs/lib/heavyPipelineLock.js";
import { describeError } from "../../services/describeError.js";
import { publishArticleToTelegraph } from "../../services/telegraph/telegraphClient.js";
import { collectSourcesForJob } from "../research/collectSourcesForJob.js";
import { enrichOfficialSources } from "../research/fetchOfficialSourceContent.js";
import { buildResearchPrompt } from "../research/buildResearchPrompt.js";
import { buildKeywordBrief, readJobBrief } from "../brief/buildKeywordBrief.js";
import { countImageMarkers } from "./generateArticleVariant.js";
import type { KeywordBrief } from "../brief/buildKeywordBrief.js";
import { collectAutocomplete } from "../brief/fetchNaverAutocomplete.js";
import { buildGeminiResearchPrompt } from "../research/buildGeminiResearchPrompt.js";
import { enforceGeminiGroundingUrls } from "../research/enforceGeminiGroundingUrls.js";
import { parseResearchFile } from "../research/parseResearchFile.js";
import type { ResearchVerdict } from "../research/parseResearchFile.js";
import { buildMedicalDisclaimer } from "./buildArticlePrompt.js";
import { buildWritingPrompt } from "./buildWritingPrompt.js";
import { parseDraftFile } from "./parseDraftFile.js";
import { generateArticleImages } from "./generateArticleImages.js";
import type { GenerateArticleImagesResult } from "./generateArticleImages.js";
import { runArticleReview } from "../review/runArticleReview.js";
import type { ArticleReviewResult } from "../review/runArticleReview.js";
import type { ArticleJobRow, ArticleRow, SourceAuthorityLevel, SourceInsert, SourceRow } from "../../types/database.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

/**
 * 헤드리스 writer는 writer.md(500줄+) + seo-guide.md(500줄+) + research 파일(20~30KB)을 읽고,
 * content-blog·korean-humanize 스킬을 순서대로 돌린 뒤 2,000~3,000자 원고를 쓴다. 실측 10분+
 * (2026-09-01 E2E에서 10분 타임아웃에 걸림) - 20분으로 늘린다.
 */
export const WRITE_TIMEOUT_MS = 20 * 60 * 1000;

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
  /**
   * 기획 브리프 생성(2026-09-17). 기본은 자동완성 + headless Claude. false면 건너뛴다(테스트 -
   * 외부 HTTP·LLM을 타면 안 된다). 실패해도 조사는 계속된다.
   */
  buildBrief?:
    | false
    | ((input: {
        job: Pick<ArticleJobRow, "keyword" | "headline" | "category" | "seed_query">;
        baselineSources: SourceInsert[];
        today: string;
      }) => ReturnType<typeof buildKeywordBrief>);
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
  // Go 버튼을 연달아 누르면 detached job:research가 동시에 여러 개 뜬다(spawnDetachedTask.ts) -
  // 이 헤비 호출만 전역 락으로 직렬화해 WebSearch 세션끼리 리소스를 나눠 쓰다 타임아웃 나는 것을
  // 막는다(2026-09-05 실측: 동시 3건 전부 18분 타임아웃 실패).
  return runWithHeavyPipelineLock(async () => {
    const result = await runHeadlessClaude({
      prompt,
      allowedTools: ["Read", "Write", "WebSearch", "WebFetch"],
      permissionMode: "acceptEdits",
      cwd: PIPELINE_ROOT,
      timeoutMs: RESEARCH_TIMEOUT_MS,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });
}

async function defaultReadResearchFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Gemini는 지시해도 가끔 ```markdown 코드펜스로 감싼다 - 방어적으로 벗겨낸다. */
function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

type DefaultResearcherInput = {
  // id는 비용 원장에 "어느 원고 때문에 나간 비용인지"를 남기기 위해 필요하다(2026-09-16).
  job: Pick<ArticleJobRow, "id" | "keyword" | "headline" | "category">;
  baselineSources: SourceInsert[];
  outputPath: string;
  today: string;
  /** 기획 브리프(2026-09-17). 실패했으면 null - researcher.md 기본 절차로 돈다. */
  brief: KeywordBrief | null;
  /** 인스타그램 수동 큐레이션 job의 원본 자료(2026-09-21). 아니면 null. */
  sourceContext: string | null;
};

/**
 * job.metadata.source === "instagram_manual"이면 캡션 + 번인 텍스트를 조사 프롬프트에 넣을
 * 1차 근거 문자열로 만든다. 아니면 null(일반 키워드 job은 지금까지와 동일하게 동작).
 */
function buildInstagramSourceContext(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || metadata.source !== "instagram_manual") return null;

  const caption = typeof metadata.instagramCaption === "string" ? metadata.instagramCaption.trim() : "";
  const burnedIn = Array.isArray(metadata.instagramBurnedInText)
    ? (metadata.instagramBurnedInText as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const url = typeof metadata.instagramUrl === "string" ? metadata.instagramUrl : null;

  const parts: string[] = [];
  if (url) parts.push(`원본 게시물: ${url}`);
  if (caption) parts.push(`캡션:\n${caption}`);
  if (burnedIn.length > 0) parts.push(`이미지에 적힌 텍스트:\n${burnedIn.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Gemini는 Write 도구가 없다 - 응답 텍스트를 직접 outputPath에 쓴다. runResearcher 계약(파일이
 * outputPath에 저장돼 있으면 ok)은 그대로 지킨다.
 */
async function runGeminiResearcherAndSave(
  input: DefaultResearcherInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  let prompt: string;
  try {
    prompt = buildGeminiResearchPrompt({ job: input.job, baselineSources: input.baselineSources, today: input.today });
  } catch (error) {
    return { ok: false, error: `[gemini] researcher.md 로드 실패: ${describeError(error)}` };
  }

  const result = await runGeminiResearch({ prompt });
  if (!result.ok) {
    return { ok: false, error: `[gemini] ${result.error}` };
  }

  // 자료조사는 이 파이프라인에서 두 번째 유료 경로다(RESEARCH_PROVIDER=gemini일 때만 돈다).
  // 실패한 호출은 과금되지 않으므로 성공분만 원장에 남긴다 - 이미지 쪽과 같은 규칙이다.
  await recordApiUsage({
    provider: "gemini",
    model: result.model,
    operation: "research.generate",
    usage: result.usage,
    jobId: input.job.id,
    metadata: { keyword: input.job.keyword },
  });

  // 실측(2026-09-03)에서 Gemini가 official/medical 항목에 실제로 grounding되지 않은 URL(최상위
  // 도메인 + 지어낸 인용문)을 붙인 사례가 나왔다 - 프롬프트 요청만으로는 안 막혀 코드로 강제한다.
  // baseline(NAVER) URL과 이 응답의 실제 groundingChunks URL만 official/medical로 인정하고,
  // 그 밖의 URL로 된 official/medical 항목은 community로 자동 강등한다(verdict도 재계산).
  const allowedUrls = new Set<string>([
    ...input.baselineSources.map((s) => s.url).filter((url): url is string => Boolean(url)),
    ...result.groundingSources.map((s) => s.url),
  ]);
  const enforced = enforceGeminiGroundingUrls(stripMarkdownFence(result.text), allowedUrls);
  if (enforced.downgradedCount > 0) {
    console.warn(
      `⚠️ [research][gemini] grounding 미확인 official/medical ${enforced.downgradedCount}건을 community로 자동 강등했습니다(재계산 verdict: ${enforced.recomputedVerdict}).`
    );
  }

  await writeFile(input.outputPath, `${enforced.text.trim()}\n`, "utf8");
  return { ok: true };
}

/**
 * RESEARCH_PROVIDER에 따라 researcher를 고른다(config/researchProvider.ts). 기본은 claude라
 * 이 함수를 안 건드리면 기존 동작과 동일하다. gemini 선택 시 실패하면 RESEARCH_FALLBACK_TO_CLAUDE
 * (기본 true)에 따라 같은 job에 한해 claude로 1회 폴백한다 - Gemini 쿼터/네트워크 장애가 job
 * 전체를 막지 않게 하기 위해서다.
 */
async function runDefaultResearcher(
  input: DefaultResearcherInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (RESEARCH_PROVIDER === "gemini") {
    const geminiResult = await runGeminiResearcherAndSave(input);
    if (geminiResult.ok) return geminiResult;
    if (!RESEARCH_FALLBACK_TO_CLAUDE) return geminiResult;
    console.warn(`⚠️ [research] Gemini 실패, Claude로 폴백합니다: ${geminiResult.error}`);
  }

  const prompt = buildResearchPrompt({
    job: input.job,
    baselineSources: input.baselineSources,
    outputPath: input.outputPath,
    today: input.today,
    brief: input.brief,
    sourceContext: input.sourceContext,
  });
  return defaultRunResearcher(prompt);
}

/** 자동완성(네이버, 비공식) + baseline 제목을 재료로 브리프 LLM 1콜. 둘 다 실패해도 예외를 내지 않는다. */
async function defaultBuildBrief(input: {
  job: Pick<ArticleJobRow, "keyword" | "headline" | "category" | "seed_query">;
  baselineSources: SourceInsert[];
  today: string;
}): ReturnType<typeof buildKeywordBrief> {
  const autocomplete = await collectAutocomplete(input.job.keyword, input.job.seed_query ?? null);
  return buildKeywordBrief({
    keyword: input.job.keyword,
    headline: input.job.headline ?? null,
    category: input.job.category ?? null,
    seedQuery: input.job.seed_query ?? null,
    autocomplete,
    baselineTitles: input.baselineSources
      .filter((s) => s.source_name !== "naver_kin" && s.source_name !== "naver_cafe")
      .map((s) => s.title)
      .filter((t): t is string => !!t),
    kinQuestions: input.baselineSources
      .filter((s) => s.source_name === "naver_kin" || s.source_name === "naver_cafe")
      .map((s) => s.title)
      .filter((t): t is string => !!t),
    today: input.today,
  });
}

/** 파일이 존재하고 maxAgeMs 안에 수정됐으면 true. 재조사 생략 판정에 쓴다. */
function fileModifiedWithin(path: string, maxAgeMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < maxAgeMs;
  } catch {
    return false;
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

  try {
    return await runResearchStageInner(job, jobId, options, startedAt);
  } catch (error) {
    // createSources(PostgrestError - Error 인스턴스 아님) 등 예외를 status:failed로 좁힌다.
    // String(error)면 "[object Object]"가 되므로 describeError를 쓴다.
    const message = describeError(error);
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[research] ${message}` });
    return { status: "failed", error: message };
  }
}

async function runResearchStageInner(
  job: ArticleJobRow,
  jobId: string,
  options: RunResearchStageOptions,
  startedAt: number
): Promise<RunResearchStageResult> {
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
  //    최근(2시간 내)에 쓰인 파일이 이미 있으면 재조사하지 않는다 - parse 단계 버그로 재실행할 때
  //    15분짜리 웹 조사를 다시 물리지 않기 위해서다(에이전트 조사 결과는 파일에 이미 있다).
  const outputPath = researchFilePath(job.keyword);
  await mkdir(dirname(outputPath), { recursive: true });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  // 1.5) 기획 브리프(2026-09-17) - 조사 **전에** "이 키워드를 검색한 독자가 알고 싶은 것"을 정한다.
  //      researcher는 이 질문에 답할 자료를 1순위로 찾고, writer는 이 질문 순서로 소제목을 잡는다.
  //      사후 검증이 아니라 사전 기획인 이유: 리서치가 시도조차 안 한 항목(분장놀이 "직접 가서 볼 수
  //      있나")은 뒤에서 아무리 검증해도 채울 재료가 없다. 실패하면 null로 두고 예전 절차로 간다 -
  //      브리프가 원고 생성을 막아서는 안 된다. 재실행이면 metadata에 있는 것을 재사용한다(LLM 1콜 절약).
  let brief: KeywordBrief | null = readJobBrief(job.metadata as Record<string, unknown> | null);
  if (!brief && options.buildBrief !== false) {
    const buildBrief = options.buildBrief ?? defaultBuildBrief;
    const built = await buildBrief({ job, baselineSources: baseline, today });
    if (built.status === "success") {
      brief = built.brief;
      await ArticleJobRepository.mergeMetadata(jobId, { brief });
      console.log(`ℹ️ [research] 기획 브리프: type=${brief.type} / Q${brief.questions.length}개 / 자동완성 ${brief.autocomplete.length}개`);
    } else {
      console.warn(`⚠️ [research] 기획 브리프 생성 실패 - 기본 절차로 조사합니다: ${built.error}`);
    }
  }

  const sourceContext = buildInstagramSourceContext(job.metadata as Record<string, unknown> | null);

  const freshFile = fileModifiedWithin(outputPath, 2 * 60 * 60 * 1000);
  if (freshFile) {
    console.log(`ℹ️ [research] 최근 research 파일 재사용(재조사 생략): ${outputPath}`);
  } else {
    let ran: { ok: true } | { ok: false; error: string };
    if (options.runResearcher) {
      // 테스트 주입은 항상 Claude 규격 프롬프트를 받는다(researcher가 직접 Write하는 계약).
      const prompt = buildResearchPrompt({ job, baselineSources: baseline, outputPath, today, brief, sourceContext });
      ran = await options.runResearcher(prompt, outputPath);
    } else {
      ran = await runDefaultResearcher({ job, baselineSources: baseline, outputPath, today, brief, sourceContext });
    }
    if (!ran.ok) {
      await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[research] ${ran.error}` });
      // status는 되돌리지 않는다(researching 유지) - 재실행 시 이 job을 다시 집을 수 있어야 한다.
      return { status: "failed", error: ran.error };
    }
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
      // published_at은 timestamptz 컬럼이다. 에이전트가 "발행일 미상" 같은 자유 텍스트를 쓰므로
      // 파싱 가능한 날짜만 저장하고 나머지는 null(원문 표기는 research 파일에 그대로 남아 있다).
      published_at: coerceTimestamp(row.publishedAt),
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

  // researchFileContent를 job.metadata에 통째로 저장한다(2026-09-15) - 클라우드에서는
  // job-research.yml과 job-write.yml이 완전히 분리된 GH Actions 러너에서 돌아서, 여기서 로컬에
  // 쓴 research/<슬러그>.md 파일이 write 단계 러너에는 없다. 그동안은 이걸 놓쳐서 job:write가
  // "파일이 없으니" 매번 조사부터 다시 했다(sources는 이미 DB에 있는데도) - 시간·비용 낭비는
  // 물론, 그 재조사 자체가 실패하면(예: claude 종료 코드 1) 이미 끝난 조사까지 덩달아 실패로
  // 보였다. runWritingStage가 이 내용으로 로컬 파일을 복원해 재조사를 건너뛴다.
  await ArticleJobRepository.mergeMetadata(jobId, {
    lastError: null,
    researchFilePath: outputPath,
    researchFileContent: fileText,
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

/**
 * parseDraftFile이 뽑은 "사용한 출처" 주석을 눈에 보이는 "**참고 자료**" 섹션으로 되살린다.
 * 주석 각 줄은 "1. [등급] 제목 (날짜) — https://..." 형태 - URL과 제목을 뽑아 "- [제목](URL)"로.
 * 헤더가 `##`가 아니라 볼드인 이유는 writer.md §6(2026-09-06 갱신) 참고.
 */
function buildReferencesSection(notes: ReadonlyArray<{ label: string; body: string }>): string | null {
  const sourcesNote = notes.find((n) => /사용한\s*출처|참고\s*자료|출처\s*목록/.test(n.label));
  if (!sourcesNote) return null;

  const items: string[] = [];
  for (const raw of sourcesNote.body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (!urlMatch) continue;
    const url = urlMatch[0].replace(/[),.]+$/, "");
    // 앞의 "1." 번호와 "[등급]"을 걷어내고, URL 앞의 " — "/" - "/"("까지를 제목으로.
    let label = line
      .slice(0, line.indexOf(urlMatch[0]))
      .replace(/^\d+[.)]\s*/, "")
      .replace(/^\[[^\]]*\]\s*/, "")
      .replace(/[\s—\-·(]+$/, "")
      .trim();
    if (!label) label = url;
    items.push(`- [${label}](${url})`);
  }
  if (items.length === 0) return null;
  // 헤더 바로 다음 줄에 빈 줄 없이 목록이 붙는다(writer.md §6, 2026-09-06) - "소제목 다음 줄은 간격 없음".
  return ["**참고 자료**", ...items].join("\n");
}

/** 자유 텍스트 날짜 표기를 timestamptz에 넣을 수 있는 ISO 문자열로 좁힌다. 못 하면 null. */
function coerceTimestamp(value: string | null): string | null {
  if (!value) return null;
  // "2025-11-20", "2025. 11. 20.", "2025/11/20", "2025년 11월 20일" 등에서 Y-M-D를 뽑는다.
  const m = value.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  // 연도만 있으면 1월 1일로.
  const yearOnly = value.match(/^\s*(\d{4})\s*$/);
  if (yearOnly) return `${yearOnly[1]}-01-01`;
  return null;
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
  /**
   * 테스트 주입: 헤드리스 writer 실행을 대체한다. rawOutput은 성공 시에도 채운다(2026-09-15) -
   * 모델이 도구 실행 자체는 "성공"(exit 0)으로 끝냈지만 draft 파일을 안 쓴 경우(마커 형식 대신
   * 확인 요청/거부성 응답 등, 민감한 실제 사건 소재에서 관측됨), 그 실제 응답 내용을 알 방법이
   * 전혀 없었다 - 아래 draft 파일 유무 검사가 실패하면 이 값을 에러 메시지에 잘라 붙인다.
   */
  runWriter?: (
    prompt: string,
    draftPath: string
  ) => Promise<{ ok: true; rawOutput: string } | { ok: false; error: string }>;
  /** 테스트 주입: draft 파일 읽기를 대체한다. */
  readDraftFile?: (path: string) => Promise<string | null>;
  /** 이미 조사된 근거를 넘기면 재수집하지 않는다. 생략하면 DB에서 먼저 찾고, 없으면 조사부터 한다. */
  sources?: SourceRow[];
  /** sources 생략 시 내부에서 runResearchStage를 호출할 때 전달할 옵션. */
  researchOptions?: RunResearchStageOptions;
  /** false로 주면 이미지 생성을 건너뛴다(테스트). 기본은 ARTICLE_IMAGE_GENERATION 플래그를 따른다. */
  generateImages?: boolean;
};

async function defaultRunWriter(prompt: string): Promise<{ ok: true; rawOutput: string } | { ok: false; error: string }> {
  // defaultRunResearcher와 같은 이유(위 주석 참고) - 집필도 동시에 여러 job이 detached로 뜰 수 있다.
  return runWithHeavyPipelineLock(async () => {
    const result = await runHeadlessClaude({
      prompt,
      allowedTools: ["Read", "Write", "Skill"],
      permissionMode: "acceptEdits",
      cwd: PIPELINE_ROOT,
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    return result.ok ? { ok: true, rawOutput: result.output } : { ok: false, error: result.error };
  });
}

async function defaultReadDraftFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

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
      /**
       * 기획 브리프의 독자 질문 중 답한 개수(2026-09-17). writer가 frontmatter에 적은 값이라 자기
       * 신고다 - 게이트가 아니라 리뷰 카드의 신호로만 쓴다. 브리프가 없던 원고면 null.
       */
      briefCoverage: { answered: number; total: number } | null;
      unansweredQuestions: string[];
      /**
       * 이미지 마커 수와 프롬프트 수가 다를 때만 채운다(2026-09-18). 다르면 그 원고의 AI 생성
       * 자리가 **전부** 빈다 - 승인 전에 알 수 있도록 리뷰 카드에 띄운다.
       */
      promptPairing: { markers: number; prompts: number } | null;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export async function runWritingStage(
  jobId: string,
  options: RunWritingStageOptions = {}
): Promise<RunWritingStageResult> {
  const job = await ArticleJobRepository.findById(jobId);
  if (!job) return { status: "skipped", reason: `job을 찾을 수 없습니다: ${jobId}` };

  // "✏️ 수정 필요"가 눌린 job(status=review, reviewDecision=needs_edit)은 재작성을 허용한다 -
  // 사람이 drafts/<슬러그>.md를 손본 뒤 다시 돌리면 그 파일을 재사용해(재작성 생략) 새 article로
  // 재수집·재검수한다. approved/published/rejected는 그대로 막는다.
  const isNeedsEditRerun =
    job.status === "review" &&
    (job.metadata as Record<string, unknown> | null)?.reviewDecision === "needs_edit";
  if (NON_RETRYABLE_STATUSES.includes(job.status) && !isNeedsEditRerun) {
    return { status: "skipped", reason: `이미 처리된 job입니다 (상태: ${job.status})` };
  }

  // 근거 + 자료조사 파일 확보. sources row가 없거나 research/[키워드].md가 없으면 조사부터 한다.
  // 로컬(같은 프로세스가 조사부터 실행)에서는 파일이 이미 있어 이 분기를 타지 않는다.
  //
  // 클라우드에서는 job-research.yml과 job-write.yml이 완전히 분리된 GH Actions 러너에서 돌아서
  // 파일이 로컬에 절대 없다(2026-09-15 발견) - sources는 DB에 있는데 파일만 없다고 매번 조사부터
  // 다시 하면 시간·비용 낭비는 물론, 그 재조사 자체가 실패했을 때(예: claude 종료 코드 1) 이미
  // 끝난 조사까지 실패로 보인다. sources가 있고 job.metadata.researchFileContent(runResearchStage가
  // 저장해 둔 원문)가 있으면 재조사 대신 그 내용으로 로컬 파일을 복원한다.
  const researchPath = researchFilePath(job.keyword);
  let sources = options.sources ?? (await listSourcesByJobId(jobId));
  if (sources.length > 0 && !existsSync(researchPath)) {
    const savedContent = (job.metadata as Record<string, unknown> | null)?.researchFileContent;
    if (typeof savedContent === "string" && savedContent.trim().length > 0) {
      await mkdir(dirname(researchPath), { recursive: true });
      await writeFile(researchPath, savedContent, "utf8");
      console.log(`ℹ️ [writing] 다른 실행이 저장해 둔 research 내용으로 파일 복원(재조사 생략): ${researchPath}`);
    }
  }
  if (sources.length === 0 || !existsSync(researchPath)) {
    const research = await runResearchStage(jobId, options.researchOptions);
    if (research.status !== "success") {
      return research.status === "skipped"
        ? research
        : { status: "failed", error: `[research] ${research.error}` };
    }
    sources = research.sources;
  }

  const startedAt = Date.now();
  await ArticleJobRepository.updateStatus(jobId, "writing");

  try {
    return await runWritingStageInner(job, jobId, options, sources, researchPath, startedAt);
  } catch (error) {
    const message = describeError(error);
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[writing] ${message}` });
    return { status: "failed", error: message };
  }
}

async function runWritingStageInner(
  job: ArticleJobRow,
  jobId: string,
  options: RunWritingStageOptions,
  sources: SourceRow[],
  researchPath: string,
  startedAt: number
): Promise<RunWritingStageResult> {
  // headline도 함께 본다 - 키워드가 짧게 정제돼 의학 어휘가 빠졌더라도 원문 제목에는 남아 있을 수 있다.
  const isMedical = isMedicalTopic(job.keyword) || (job.headline ? isMedicalTopic(job.headline) : false);

  // 헤드리스 writer 에이전트 - writer.md + seo-guide.md 계약대로 research 파일을 읽고
  // drafts/<슬러그>.md를 쓴다. Node는 조율만 한다(CLAUDE.md 원고 파이프라인 운영 규칙).
  // 최근(2시간 내) draft가 이미 있으면 재작성하지 않는다(파싱/저장 버그로 재실행할 때 집필 비용 절약).
  const draftPath = draftFilePath(job.keyword);
  await mkdir(dirname(draftPath), { recursive: true });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  // 모델이 draft 파일을 안 썼을 때(아래 draftText 빈 값 검사) 무슨 응답을 했길래 그랬는지 에러
  // 메시지에 붙이려고 밖에 둔다(2026-09-15) - 민감한 실제 사건 소재에서 writer가 마커 형식 대신
  // 확인 요청/거부성 텍스트로 응답하는 경우가 있는데, 그동안은 이 내용이 완전히 유실됐다.
  let rawOutput: string | null = null;

  if (fileModifiedWithin(draftPath, 2 * 60 * 60 * 1000)) {
    console.log(`ℹ️ [writing] 최근 draft 파일 재사용(재작성 생략): ${draftPath}`);
  } else {
    const prompt = buildWritingPrompt({
      job,
      researchFilePath: researchPath,
      draftFilePath: draftPath,
      isMedical,
      today,
      brief: readJobBrief(job.metadata as Record<string, unknown> | null),
    });
    const runWriter = options.runWriter ?? ((p) => defaultRunWriter(p));
    const ran = await runWriter(prompt, draftPath);
    if (!ran.ok) {
      await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[writing] ${ran.error}` });
      // status는 되돌리지 않는다(writing 유지) - 이미 모은 근거·자료조사 파일은 재사용할 수 있다.
      return { status: "failed", error: ran.error };
    }
    rawOutput = ran.rawOutput;
  }
  const durationMs = Date.now() - startedAt;

  const readDraftFile = options.readDraftFile ?? defaultReadDraftFile;
  const draftText = await readDraftFile(draftPath);
  if (!draftText || draftText.trim().length === 0) {
    const outputSnippet = rawOutput ? ` - 모델 응답: ${rawOutput.trim().slice(0, 500)}` : "";
    const error = `writer가 draft 파일을 만들지 않았습니다: ${draftPath}${outputSnippet}`;
    await ArticleJobRepository.mergeMetadata(jobId, { lastError: `[writing] ${error}` });
    return { status: "failed", error };
  }
  const parsed = parseDraftFile(draftText);
  const title = parsed.title ?? job.keyword;

  // 마커 ↔ 프롬프트 짝 검사(2026-09-18). 개수가 다르면 parseManuscriptBlocks가 안전을 위해
  // **모든 프롬프트를 null로 떨어뜨려** 그 원고의 AI 생성 자리가 전부 빈다. 지금까지는 그 사실이
  // 이미지 단계에 가서야 "프롬프트 없음"으로 드러났는데, 그때는 이미 승인이 끝난 뒤였다.
  // 실측(2026-09-18): 13건 중 2건이 writer가 [IMAGE PROMPT:] 줄을 빠뜨린 경우였다
  // (이청아 마커 5·프롬프트 2, 청년미래적금 마커 6·프롬프트 1).
  const markerCount = countImageMarkers(parsed.body);
  const promptPairing =
    markerCount === parsed.imagePrompts.length
      ? null
      : { markers: markerCount, prompts: parsed.imagePrompts.length };
  if (promptPairing) {
    console.warn(
      `⚠️ [writing] 이미지 마커 ${promptPairing.markers}개 / 프롬프트 ${promptPairing.prompts}개 - 짝이 맞지 않아 AI 생성 자리가 전부 빕니다.`
    );
  }

  // 인스타 캡처 후보 승격(2026-09-22). 승인이 사람에 의해 즉시 일어날 수 있어(텔레그램 버튼),
  // 이 시점(write 완료 = 마커 수 확정)과 승인 사이에 별도 CLI(ig:promote-images)를 기다리면 그
  // 틈에 승인이 먼저 끝나 metadata.images가 비어 있는 채로 승인 이후 파이프라인이 돌고, 거기서
  // 웹 이미지 자동 검색이 대신 채워 인스타 캡처 사진이 최종 원고에서 통째로 빠진다(2026-09-21
  // 실측: "김지원 밀라노 근황" job에서 실제로 발생). 그래서 write 완료 시점에 곧바로
  // instagramImages -> images로 옮긴다 - promoteInstagramImagesCli.ts와 같은 규칙(마커 수를
  // 넘는 후보는 버림)이며, 그 CLI는 이미 승격된 job에 대해서는 아무 일도 하지 않으므로 안전하다.
  const instagramCandidates =
    job.metadata?.source === "instagram_manual"
      ? (job.metadata?.instagramImages as ManuscriptImage[] | undefined)
      : undefined;
  const instagramPromotedImages =
    Array.isArray(instagramCandidates) && instagramCandidates.length > 0
      ? instagramCandidates.filter((c) => c.index <= parsed.imagePrompts.length)
      : null;
  if (instagramCandidates && instagramPromotedImages) {
    const dropped = instagramCandidates.length - instagramPromotedImages.length;
    if (dropped > 0) {
      console.warn(`⚠️ [writing] 인스타 캡처 후보 중 마커(${parsed.imagePrompts.length}개)를 넘는 ${dropped}개는 버립니다.`);
    }
    console.log(`ℹ️ [writing] 인스타 캡처 후보 ${instagramPromotedImages.length}개를 metadata.images로 승격했습니다.`);
  }

  // 이미지: 2026-09-01부터 API 자동생성 기본 보류(CLAUDE.md 운영 규칙). 보류면 writer가 남긴
  // `[IMAGE: 설명]` 마커를 본문에 그대로 두고(passthrough) 사용자가 직접 삽입한다.
  // generateArticleImages의 삽입 지점 판정은 2026-09-06부터 `**볼드**` 소제목 기준이다(writer.md §6).
  const imageGenerationHeld = !ARTICLE_IMAGE_GENERATION_ENABLED;
  const imageGeneration: GenerateArticleImagesResult =
    options.generateImages === false || imageGenerationHeld
      ? { body: parsed.body, images: [], failures: [] }
      : await generateArticleImages({
          jobId,
          title,
          keyword: job.keyword,
          category: job.category,
          seoDescription: null,
          body: parsed.body,
        });
  if (imageGeneration.failures.length > 0) {
    console.error(`⚠️ 이미지 ${imageGeneration.failures.length}건 생성 실패 (원고는 계속 진행) -`, imageGeneration.failures.join(" / "));
  }

  // 최종 본문 = body + ## 참고 자료 + 해시태그 한 줄 + (의학 주제면) 출처 신뢰도 고지.
  // 참고 자료를 여기서 붙이는 이유(2026-09-01): writer.md §9는 출처를 <!-- 사용한 출처 --> 주석에만
  // 남기지만(본문 노출 금지), 발행 글에는 독자·SEO·검수를 위해 눈에 보이는 참고 자료 섹션이
  // 필요하다. parseDraftFile이 뽑아 둔 "사용한 출처" 주석을 마크다운 링크 목록으로 되살린다.
  // 해시태그/고지도 매번 정확히 지켜져야 해 여기서 결정적으로 붙인다.
  const references = buildReferencesSection(parsed.checkNotes);
  const disclaimer = buildMedicalDisclaimer(isMedical, sources);
  const content = [
    imageGeneration.body,
    references,
    parsed.hashtags.length > 0 ? parsed.hashtags.join(" ") : null,
    disclaimer,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  const article = await createArticleForJob({
    job_id: jobId,
    title,
    content,
    status: "review",
    ai_model: "claude-headless(writer.md+korean-humanize)",
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
  //
  // 팩트 대조 대상(2026-09-01): sources 테이블 + research/<슬러그>.md 전문. 파일 기반 파이프라인에서
  // 에이전트가 인용한 웹 출처는 sources에 URL만 들어가고 본문(content)이 없어, 파일 전문을 함께
  // 넘겨야 "근거에서 확인되지 않음" 오탐을 줄일 수 있다(§2 확인된 사실 / §6 수치·기준 정리).
  const researchText = await defaultReadResearchFile(researchPath);
  const reviewSources = researchText
    ? [...sources.map((s) => ({ content: s.content })), { content: researchText }]
    : sources.map((s) => ({ content: s.content }));
  const review = runArticleReview({
    job: { category: job.category },
    article: { title: article.title, content: article.content, created_at: article.created_at },
    sources: reviewSources,
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
    lastError: null,
    // 재작성이 끝났으니 이전 검수 결정(needs_edit 등)을 지운다 - 새 원고는 다시 검수 대기다.
    reviewDecision: null,
    reviewedAt: null,
    hashtags: parsed.hashtags,
    draftFilePath: draftPath,
    // writer가 [IMAGE PROMPT:]로 남긴 이미지 제작 지시. 사용자가 이미지를 만들 때 참고.
    imagePrompts: parsed.imagePrompts,
    skillUsed: parsed.skillUsed,
    verdictFromResearch: parsed.verdictFromResearch,
    // writer가 남긴 <!-- 확인 필요 --> / <!-- 사용한 출처 --> 주석. 검수·감사용.
    draftCheckNotes: parsed.checkNotes,
    isMedical,
    requiresMedicalReview: isMedical,
    telegraphUrl,
    // 새 테이블(review_checks) 대신 metadata에 저장한다(설계 7절 결정) - migration 수동 적용
    // 부담을 지금 질 이유가 없고, 하루 1~2건 규모에서는 JSON 연산자로 충분히 분석할 수 있다.
    reviewChecks: review.checks,
    imageCounts: { succeeded: imageGeneration.images.length, failed: imageGeneration.failures.length },
    imageFailures: imageGeneration.failures,
    imageGenerationHeld,
    ...(instagramPromotedImages
      ? { images: instagramPromotedImages, imagesReadyAt: new Date().toISOString() }
      : {}),
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
    briefCoverage: parsed.briefCoverage,
    unansweredQuestions: parsed.unansweredQuestions,
    promptPairing,
  };
}

// ---------- 편의 함수: 조사 + 작성을 한 번에 ----------

export type RunArticleJobOptions = RunResearchStageOptions &
  Pick<RunWritingStageOptions, "runWriter" | "readDraftFile" | "generateImages">;

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
    runWriter: options.runWriter,
    readDraftFile: options.readDraftFile,
    generateImages: options.generateImages,
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
