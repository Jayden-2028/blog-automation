// 인물 제미나이 그림자 트랙의 본체(2026-11-19). person job 하나에 대해 Gemini가 **혼자** 조사하고 혼자 글을 쓴다.
//
// 왜 있나: 사용자가 요청한 인물 글마다 "기존 파이프라인의 원고"와 "Gemini 단독 원고"를 나란히 놓고 비교해
// 나중에 어느 쪽이 인물 글을 쓸지 정하려 한다. 그래서 기존 흐름(Claude 조사+집필)은 한 줄도 바뀌지 않고,
// 이 트랙은 그 옆에서 **독립적으로** 돈다(기존 조사 결과에 의존하지 않는다).
//
// 실행 위치: **맥미니의 Antigravity CLI(`agy`)**, 사용자의 Google AI 구독 로그인. API 요금이 없고 GitHub Actions에서는
// 못 돈다. 폴러(jobs/geminiPersonPollJob.ts)가 대기열(geminiShadowQueue.ts)에서 집어 이 함수를 부른다.
//
// 지침:
//  - zero-base: Gemini에게 우리 규격을 주지 않는다(geminiPersonPrompts.ts 머리 주석).
//  - 이미지 보류: 이미지 마커를 요청하지 않고, 이미지 수집·생성도 하지 않는다.
//  - 호출은 둘: 조사(웹 검색을 쓰고 출처 URL을 남기게 한다) -> 집필. 출처는 응답 본문의 URL에서 뽑는다
//    (agy에는 grounding 메타데이터가 없다).
//  - 저장: job.metadata.geminiShadow(원자 병합). 새 테이블·migration 없음. 비용 원장에는 쓰지 않는다(구독) -
//    토큰 수만 geminiShadow.usage에 남긴다.
//  - 어떤 실패도 기존 파이프라인에 영향이 없다 - 이 함수는 **던지지 않고** 결과를 돌려준다.
//  - 호출하기 전에 이미 claim돼 있다고 가정한다(startedAt은 claim이 적었다). 여기서 startedAt을 다시 적지 않는다.

import { agyExtraArgs, geminiPersonModel, isGeminiPersonShadowEnabled } from "../../config/geminiPerson.js";
import { runAgy } from "../../services/llm/runAgy.js";
import type { AgyUsage, RunAgyResult } from "../../services/llm/runAgy.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";
import { buildGeminiPersonResearchPrompt, buildGeminiPersonWritePrompt } from "./geminiPersonPrompts.js";
import type { GeminiPersonSubject } from "./geminiPersonPrompts.js";
import { parseGeminiPersonOutput } from "./parseGeminiPersonOutput.js";
import { readGeminiShadow } from "./geminiShadowTypes.js";
import type { GeminiShadow, GeminiShadowCallUsage, GeminiShadowSource, GeminiShadowUsage } from "./geminiShadowTypes.js";

/** 조사 노트는 metadata(jsonb)에 통째로 실린다 - 행이 너무 비대해지지 않게 상한을 둔다. */
const RESEARCH_NOTES_LIMIT = 30_000;

export type RefreshOutcome = "dispatched" | "no_token";

export type GeminiPersonDeps = {
  findJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  runAgyImpl?: typeof runAgy;
  /** manifest(뷰어)에 이미 이 job의 원고 행이 있는가. 있으면 완료 후 페이지 갱신 + 알림. */
  hasManifestEntry?: (jobId: string) => Promise<boolean>;
  /** 페이지 갱신 발화. 토큰이 없는 환경이면 "no_token"(맥미니 .env에 GITHUB_TOKEN이 없는 경우). */
  dispatchRefresh?: () => Promise<RefreshOutcome>;
  /** 텔레그램 한 통(트랙 봇). pageUrl이 있으면 `📄 원고 페이지 열기` 버튼을 붙인다. */
  notify?: (job: ArticleJobRow, text: string, pageUrl: string | null) => Promise<void>;
  pageUrlFor?: (job: ArticleJobRow) => string | null;
  now?: () => Date;
  isEnabled?: () => boolean;
  model?: string;
  extraArgs?: string[];
  timeoutMs?: number;
};

export type GeminiPersonResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; shadow: GeminiShadow; refresh: RefreshOutcome | "no_page" }
  | { status: "failed"; error: string; authRequired: boolean; shadow: GeminiShadow };

export type RunGeminiPersonOptions = {
  /** 이미 끝난 기록이 있어도 다시 돈다(실패 후 수동 재실행). */
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

/** 응답 텍스트의 URL을 출처로 뽑는다(마크다운 링크면 제목도). 끝 구두점을 떼고 중복을 뺀다. */
export function extractSources(texts: readonly { text: string; via: GeminiShadowSource["via"] }[]): GeminiShadowSource[] {
  const out: GeminiShadowSource[] = [];
  const seen = new Set<string>();
  const clean = (url: string): string => url.replace(/[.,;:!?'"]+$/, "").replace(/\)+$/, (m) => (url.includes("(") ? m : ""));
  const push = (url: string, title: string | null, via: GeminiShadowSource["via"]): void => {
    const cleaned = clean(url);
    const key = cleaned.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(cleaned) || seen.has(key)) return;
    seen.add(key);
    out.push({ title, url: cleaned, via });
  };
  for (const { text, via } of texts) {
    for (const m of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) push(m[2], m[1].trim(), via);
    for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'`<]+/g)) push(m[0], null, via);
  }
  return out;
}

function toCallUsage(result: Extract<RunAgyResult, { ok: true }>): GeminiShadowCallUsage {
  const u: AgyUsage = result.usage;
  return { model: result.model, ...u, durationMs: result.durationMs, numTurns: result.numTurns };
}

function sumTokens(a: GeminiShadowCallUsage | null, b: GeminiShadowCallUsage | null): number | null {
  if (!a || !b || a.totalTokens == null || b.totalTokens == null) return null;
  return a.totalTokens + b.totalTokens;
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
  const agy = deps.runAgyImpl ?? runAgy;
  const model = deps.model ?? geminiPersonModel();

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

  const requestedAt = existing?.requestedAt ?? now().toISOString();
  const startedAt = existing?.startedAt && !options.force ? existing.startedAt : now().toISOString();
  let shadow: GeminiShadow = {
    requestedAt,
    startedAt,
    ...(existing?.claimId ? { claimId: existing.claimId } : {}),
    ...(existing?.attempts ? { attempts: existing.attempts } : {}),
    ...(model ? { model } : {}),
  };

  const save = async (next: GeminiShadow): Promise<void> => {
    shadow = next;
    await merge(jobId, { geminiShadow: next });
  };

  const fail = async (error: string, authRequired: boolean, partial: Partial<GeminiShadow> = {}): Promise<GeminiPersonResult> => {
    const failed: GeminiShadow = { ...shadow, ...partial, finishedAt: now().toISOString(), error };
    try {
      await save(failed);
    } catch (saveError) {
      console.warn(`⚠️ [gemini-person] 실패 기록 저장 실패: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    }
    try {
      const hint = authRequired ? `\n로그인 뒤 \`npm run job:gemini-person-poll -- ${jobId} --force\`로 다시 돌리세요.` : "";
      await deps.notify?.(job as ArticleJobRow, `⚠️ <b>제미나이 버전 실패</b>\n${escapeHtml(error.slice(0, 200))}${escapeHtml(hint)}`, null);
    } catch (notifyError) {
      console.warn(`⚠️ [gemini-person] 실패 알림 실패: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`);
    }
    return { status: "failed", error, authRequired, shadow: failed };
  };

  try {
    await save(shadow);
    const subject = subjectFor(job);
    const base = { model, extraArgs: deps.extraArgs ?? agyExtraArgs(), timeoutMs: deps.timeoutMs };

    // ── 호출 1: 조사 ──
    const research = await agy({ ...base, prompt: buildGeminiPersonResearchPrompt(subject) });
    if (!research.ok) return await fail(`조사 호출 실패: ${research.error}`, research.authRequired);
    const researchUsage = toCallUsage(research);
    const researchNotes = research.text.length > RESEARCH_NOTES_LIMIT ? `${research.text.slice(0, RESEARCH_NOTES_LIMIT)}\n...(이하 생략)` : research.text;
    const recordedModel = research.model ?? model;
    if (recordedModel) shadow = { ...shadow, model: recordedModel };

    // ── 호출 2: 집필 ──
    const write = await agy({ ...base, prompt: buildGeminiPersonWritePrompt(subject, research.text) });
    if (!write.ok) {
      return await fail(`집필 호출 실패: ${write.error}`, write.authRequired, {
        researchNotes,
        usage: { research: researchUsage, write: null, totalTokens: null },
      });
    }
    const writeUsage = toCallUsage(write);
    const usage: GeminiShadowUsage = { research: researchUsage, write: writeUsage, totalTokens: sumTokens(researchUsage, writeUsage) };

    const parsed = parseGeminiPersonOutput(write.text);
    if (!parsed) return await fail("집필 결과를 제목/본문으로 가르지 못했다(빈 출력)", false, { researchNotes, usage });

    const done: GeminiShadow = {
      ...shadow,
      model: write.model ?? recordedModel,
      finishedAt: now().toISOString(),
      title: parsed.title,
      body: parsed.body,
      researchNotes,
      sources: extractSources([
        { text: research.text, via: "notes" },
        { text: parsed.body, via: "body" },
      ]),
      usage,
      ...(parsed.warning ? { warning: parsed.warning } : {}),
    };
    await save(done);

    const refresh = await afterDone(job, done, deps);
    return { status: "done", shadow: done, refresh };
  } catch (error) {
    return await fail(`예기치 못한 오류: ${error instanceof Error ? error.message : String(error)}`, false);
  }
}

/** 완료 뒤처리: 뷰어 행이 이미 있으면 페이지 갱신 + 텔레그램 한 통. 여기서 나는 오류는 결과를 바꾸지 않는다. */
async function afterDone(job: ArticleJobRow, done: GeminiShadow, deps: GeminiPersonDeps): Promise<RefreshOutcome | "no_page"> {
  try {
    const hasEntry = deps.hasManifestEntry ? await deps.hasManifestEntry(job.id) : false;
    if (!hasEntry) return "no_page"; // 원고 준비 때 페이지를 그리면서 덧입는다(writeManuscriptPages).
    const refresh = (await deps.dispatchRefresh?.()) ?? "no_token";
    const pageUrl = deps.pageUrlFor?.(job) ?? null;
    const tokens = done.usage?.totalTokens != null ? ` · ${done.usage.totalTokens.toLocaleString("en-US")} 토큰` : "";
    const tail =
      refresh === "dispatched"
        ? "원고 페이지의 \"제미나이\" 탭에서 기존 원고와 비교해 보세요. (페이지 갱신에 1~2분)"
        : "⚠️ 맥미니에 GITHUB_TOKEN이 없어 페이지 갱신을 요청하지 못했습니다. 다음 원고 페이지 배포 때 \"제미나이\" 탭이 나타납니다(급하면 manuscripts-refresh 워크플로를 수동 실행).";
    await deps.notify?.(job, `🤖 <b>제미나이 버전이 준비됐어요</b>\n<b>${escapeHtml(job.keyword)}</b>${tokens}\n\n${tail}`, pageUrl);
    return refresh;
  } catch (error) {
    console.warn(`⚠️ [gemini-person] 완료 뒤처리 실패(결과는 저장됨): ${error instanceof Error ? error.message : String(error)}`);
    return "no_page";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
