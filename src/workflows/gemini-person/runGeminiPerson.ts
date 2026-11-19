// 인물 제미나이 그림자 트랙의 본체(2026-11-19). person job 하나에 대해 Gemini가 **혼자** 조사하고 혼자 글을 쓴다.
//
// 왜 있나: 사용자가 요청한 인물 글마다 "기존 파이프라인의 원고"와 "Gemini 단독 원고"를 나란히 놓고 비교해
// 나중에 어느 쪽이 인물 글을 쓸지 정하려 한다. 그래서 기존 흐름(Claude 조사+집필)은 한 줄도 바뀌지 않고,
// 이 트랙은 그 옆에서 **독립적으로·병렬로** 돈다(기존 조사 결과에 의존하지 않는다).
//
// 지침:
//  - zero-base: Gemini에게 우리 규격을 주지 않는다(geminiPersonPrompts.ts 머리 주석).
//  - 이미지 보류: 이미지 마커를 요청하지 않고, 이미지 수집·생성도 하지 않는다.
//  - 호출 1(조사)은 google_search grounding. **호출 2(집필)도 grounding을 켠다** - 조사 노트에 빈칸이 있을 때
//    모델이 스스로 한 번 더 확인할 수 있어야 "Gemini 혼자 쓴 글"이 공정하다. 대신 검색 쿼리 요금($14/1,000건)이
//    한 번 더 붙고, 집필 응답이 짧아지는 경향이 있으면 비교 단계에서 알아챈다(출처는 호출 2의 것도 합친다).
//  - 저장: job.metadata.geminiShadow(원자 병합). 새 테이블·migration 없음.
//  - 어떤 실패도 기존 파이프라인에 영향이 없다 - 이 함수는 **던지지 않고** 결과를 돌려준다.

import { GEMINI_PERSON_MODEL, isGeminiPersonShadowEnabled } from "../../config/geminiPerson.js";
import { estimateCostUsd } from "../../config/apiPricing.js";
import { runGeminiResearch } from "../../services/llm/runGeminiResearch.js";
import type { RunGeminiResearchResult, GeminiGroundingSource } from "../../services/llm/runGeminiResearch.js";
import { isGroundingRedirect, normalizeUrl, resolveOne } from "../../services/llm/resolveGroundingUrls.js";
import { recordApiUsage } from "../../services/usage/recordApiUsage.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";
import { buildGeminiPersonResearchPrompt, buildGeminiPersonWritePrompt } from "./geminiPersonPrompts.js";
import type { GeminiPersonSubject } from "./geminiPersonPrompts.js";
import { parseGeminiPersonOutput } from "./parseGeminiPersonOutput.js";
import { readGeminiShadow } from "./geminiShadowTypes.js";
import type { GeminiShadow, GeminiShadowCallUsage, GeminiShadowSource, GeminiShadowUsage } from "./geminiShadowTypes.js";

/** 조사 노트·본문은 metadata(jsonb)에 통째로 실린다 - 행이 너무 비대해지지 않게 노트에 상한을 둔다. */
const RESEARCH_NOTES_LIMIT = 30_000;
/** thinking 토큰이 한도를 같이 먹는다(3.x). 조사는 길게, 집필은 더 길게. */
const RESEARCH_MAX_OUTPUT_TOKENS = 32_000;
const WRITE_MAX_OUTPUT_TOKENS = 48_000;
const WRITE_TEMPERATURE = 0.7;
const RESEARCH_TEMPERATURE = 0.2;
const CALL_TIMEOUT_MS = 8 * 60 * 1000;
/** 같은 job의 실행이 이 시간 안에 시작됐으면 "진행 중"으로 본다(--force 없이는 건너뛴다). */
const STALE_RUN_MS = 30 * 60 * 1000;

export type GeminiPersonDeps = {
  findJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  callGemini?: typeof runGeminiResearch;
  recordUsage?: typeof recordApiUsage;
  /** 리디렉션 해석용 fetch. 테스트에서 주입한다. */
  fetchImpl?: typeof fetch;
  /** manifest(뷰어)에 이미 이 job의 원고 행이 있는가. 있으면 완료 후 페이지 갱신 + 알림. */
  hasManifestEntry?: (jobId: string) => Promise<boolean>;
  dispatchRefresh?: () => Promise<void>;
  /** 텔레그램 한 통(트랙 봇). pageUrl이 있으면 `📄 원고 페이지 열기` 버튼을 붙인다. */
  notify?: (job: ArticleJobRow, text: string, pageUrl: string | null) => Promise<void>;
  pageUrlFor?: (job: ArticleJobRow) => string | null;
  now?: () => Date;
  isEnabled?: () => boolean;
  model?: string;
  apiKey?: string;
};

export type GeminiPersonResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; shadow: GeminiShadow; pageRefreshed: boolean }
  | { status: "failed"; error: string; shadow: GeminiShadow };

export type RunGeminiPersonOptions = {
  /** 이미 시작/완료 기록이 있어도 다시 돈다(실패 후 수동 재실행). */
  force?: boolean;
};

function subjectFor(job: ArticleJobRow): GeminiPersonSubject {
  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const pieces = [
    typeof job.headline === "string" ? job.headline : "",
    typeof meta.personBackground === "string" ? meta.personBackground : "",
    typeof meta.instagramCaption === "string" ? meta.instagramCaption : "",
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return { name: job.keyword, requestNote: pieces.length > 0 ? pieces.join("\n") : null };
}

function urlsInText(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? [];
  return found.map((url) => url.replace(/[.,;:]+$/, ""));
}

/** grounding 리디렉션을 풀고, 조사 노트 본문에 적힌 URL을 합쳐 중복 없는 출처 목록으로 만든다. */
export async function buildSources(
  grounding: readonly GeminiGroundingSource[],
  notesText: string,
  fetchImpl: typeof fetch = fetch
): Promise<GeminiShadowSource[]> {
  const out: GeminiShadowSource[] = [];
  const seen = new Set<string>();
  const push = (source: GeminiShadowSource): void => {
    const key = normalizeUrl(source.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(source);
  };

  for (const source of grounding) {
    // 못 푼 리디렉션은 원 주소를 그대로 둔다(클릭하면 열린다). 제목에는 사이트 도메인이 들어 있다.
    const resolved = isGroundingRedirect(source.url) ? await resolveOne(source.url, fetchImpl, 10_000) : source.url;
    push({ title: source.title, url: resolved ?? source.url, via: "grounding" });
  }
  for (const url of urlsInText(notesText)) {
    if (isGroundingRedirect(url)) continue;
    push({ title: null, url, via: "notes" });
  }
  return out;
}

function toCallUsage(
  result: Extract<RunGeminiResearchResult, { ok: true }>,
  now: Date
): GeminiShadowCallUsage {
  const u = result.usage;
  const cost = estimateCostUsd({
    model: result.model,
    inputTokens: u ? (u.inputTokens ?? 0) + (u.toolUseTokens ?? 0) : null,
    outputTokens: u ? (u.outputTokens ?? 0) + (u.thinkingTokens ?? 0) : null,
    occurredAt: now,
  });
  return {
    model: result.model,
    inputTokens: u?.inputTokens ?? null,
    outputTokens: u?.outputTokens ?? null,
    thinkingTokens: u?.thinkingTokens ?? null,
    toolUseTokens: u?.toolUseTokens ?? null,
    totalTokens: u?.totalTokens ?? null,
    durationMs: result.durationMs,
    costUsd: cost.costUsd,
  };
}

function sumCost(research: GeminiShadowCallUsage | null, write: GeminiShadowCallUsage | null): number | null {
  if (!research || !write || research.costUsd == null || write.costUsd == null) return null;
  return Math.round((research.costUsd + write.costUsd) * 1_000_000) / 1_000_000;
}

export async function runGeminiPerson(
  jobId: string,
  options: RunGeminiPersonOptions = {},
  deps: GeminiPersonDeps = {}
): Promise<GeminiPersonResult> {
  const now = deps.now ?? (() => new Date());
  const isEnabled = deps.isEnabled ?? (() => isGeminiPersonShadowEnabled());
  const findJob = deps.findJob ?? ((id: string) => ArticleJobRepository.findById(id));
  const merge = deps.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch));
  const call = deps.callGemini ?? runGeminiResearch;
  const model = deps.model ?? GEMINI_PERSON_MODEL;

  if (!isEnabled()) return { status: "skipped", reason: "PERSON_GEMINI_SHADOW=false(스위치 꺼짐)" };

  let job: ArticleJobRow | null;
  try {
    job = await findJob(jobId);
  } catch (error) {
    return { status: "skipped", reason: `job 조회 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!job) return { status: "skipped", reason: "job을 찾을 수 없다" };
  if (job.category !== "person") return { status: "skipped", reason: `person이 아니다(category=${job.category ?? "없음"})` };

  const existing = readGeminiShadow(job.metadata);
  if (!options.force && existing?.finishedAt) return { status: "skipped", reason: "이미 끝난 실행이 있다(다시 하려면 force)" };
  if (!options.force && existing?.startedAt && now().getTime() - new Date(existing.startedAt).getTime() < STALE_RUN_MS) {
    return { status: "skipped", reason: "다른 실행이 진행 중이다" };
  }

  const requestedAt = existing?.requestedAt ?? now().toISOString();
  const startedAt = now().toISOString();
  let shadow: GeminiShadow = { requestedAt, model, startedAt };

  const save = async (next: GeminiShadow): Promise<void> => {
    shadow = next;
    await merge(jobId, { geminiShadow: next });
  };

  const fail = async (error: string, partial: Partial<GeminiShadow> = {}): Promise<GeminiPersonResult> => {
    const failed: GeminiShadow = { ...shadow, ...partial, finishedAt: now().toISOString(), error };
    try {
      await save(failed);
    } catch (saveError) {
      console.warn(`⚠️ [gemini-person] 실패 기록 저장 실패: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    }
    try {
      await deps.notify?.(job as ArticleJobRow, `⚠️ <b>제미나이 버전 실패</b>\n${error.slice(0, 200)}`, null);
    } catch (notifyError) {
      console.warn(`⚠️ [gemini-person] 실패 알림 실패: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`);
    }
    return { status: "failed", error, shadow: failed };
  };

  try {
    await save(shadow);
    const subject = subjectFor(job);
    const recordUsage = deps.recordUsage ?? recordApiUsage;
    const base = { model, apiKey: deps.apiKey, timeoutMs: CALL_TIMEOUT_MS };

    // ── 호출 1: 조사 ──
    const research = await call({
      ...base,
      prompt: buildGeminiPersonResearchPrompt(subject),
      grounding: true,
      temperature: RESEARCH_TEMPERATURE,
      maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
    });
    if (!research.ok) return await fail(`조사 호출 실패: ${research.error}`);
    await recordUsageFor(recordUsage, research, jobId, "gemini-person.research", subject.name);
    const researchUsage = toCallUsage(research, now());
    const researchNotes = research.text.length > RESEARCH_NOTES_LIMIT ? `${research.text.slice(0, RESEARCH_NOTES_LIMIT)}\n...(이하 생략)` : research.text;

    // ── 호출 2: 집필 ──
    const write = await call({
      ...base,
      prompt: buildGeminiPersonWritePrompt(subject, research.text),
      grounding: true,
      temperature: WRITE_TEMPERATURE,
      maxOutputTokens: WRITE_MAX_OUTPUT_TOKENS,
    });
    if (!write.ok) {
      return await fail(`집필 호출 실패: ${write.error}`, {
        researchNotes,
        usage: { research: researchUsage, write: null, totalCostUsd: null },
      });
    }
    await recordUsageFor(recordUsage, write, jobId, "gemini-person.write", subject.name);
    const writeUsage = toCallUsage(write, now());
    const usage: GeminiShadowUsage = { research: researchUsage, write: writeUsage, totalCostUsd: sumCost(researchUsage, writeUsage) };

    const parsed = parseGeminiPersonOutput(write.text);
    if (!parsed) return await fail("집필 결과를 제목/본문으로 가르지 못했다(빈 출력)", { researchNotes, usage });

    const sources = await buildSources([...research.groundingSources, ...write.groundingSources], research.text, deps.fetchImpl ?? fetch);

    const done: GeminiShadow = {
      requestedAt,
      model,
      startedAt,
      finishedAt: now().toISOString(),
      title: parsed.title,
      body: parsed.body,
      researchNotes,
      sources,
      usage,
      ...(parsed.warning ? { warning: parsed.warning } : {}),
    };
    await save(done);

    const pageRefreshed = await afterDone(job, done, deps);
    return { status: "done", shadow: done, pageRefreshed };
  } catch (error) {
    return await fail(`예기치 못한 오류: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function recordUsageFor(
  recordUsage: typeof recordApiUsage,
  result: Extract<RunGeminiResearchResult, { ok: true }>,
  jobId: string,
  operation: string,
  name: string
): Promise<void> {
  const u = result.usage;
  // 비용 원장은 던지지 않는다(recordApiUsage 계약). thinking은 출력 단가, 도구 프롬프트는 입력 단가로 청구된다.
  await recordUsage({
    provider: "gemini",
    model: result.model,
    operation,
    usage: u
      ? {
          inputTokens: u.inputTokens == null && u.toolUseTokens == null ? null : (u.inputTokens ?? 0) + (u.toolUseTokens ?? 0),
          outputTokens: u.outputTokens == null && u.thinkingTokens == null ? null : (u.outputTokens ?? 0) + (u.thinkingTokens ?? 0),
          totalTokens: u.totalTokens,
        }
      : null,
    jobId,
    metadata: { keyword: name, thinkingTokens: u?.thinkingTokens ?? null, toolUseTokens: u?.toolUseTokens ?? null, searchGrounding: true },
  });
}

/** 완료 뒤처리: 뷰어 행이 이미 있으면 페이지 갱신 + 텔레그램 한 통. 여기서 나는 오류는 결과를 바꾸지 않는다. */
async function afterDone(job: ArticleJobRow, done: GeminiShadow, deps: GeminiPersonDeps): Promise<boolean> {
  try {
    const hasEntry = deps.hasManifestEntry ? await deps.hasManifestEntry(job.id) : false;
    if (!hasEntry) return false; // 원고 준비 때 페이지를 그리면서 덧입는다(writeManuscriptPages).
    await deps.dispatchRefresh?.();
    const pageUrl = deps.pageUrlFor?.(job) ?? null;
    const cost = done.usage?.totalCostUsd != null ? ` · 토큰 비용 약 $${done.usage.totalCostUsd.toFixed(2)}` : "";
    await deps.notify?.(
      job,
      `🤖 <b>제미나이 버전이 준비됐어요</b>\n<b>${escapeHtml(job.keyword)}</b>${cost}\n\n원고 페이지의 "제미나이" 탭에서 기존 원고와 비교해 보세요. (페이지 갱신에 1~2분)`,
      pageUrl
    );
    return true;
  } catch (error) {
    console.warn(`⚠️ [gemini-person] 완료 뒤처리 실패(결과는 저장됨): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
