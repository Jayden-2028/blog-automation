// scenepick job 1건을 끝까지(2026-11-21): 작업장 준비 -> Codex 발주 -> 형식 검사(실패 시 재작업 1회) -> 이미지 업로드 ->
// 뷰어 manifest 한 행 저장 -> job 마감 -> 페이지 재배포 발화 -> 사회 봇 알림. **맥미니에서만** 돈다(scenepickPollJob).
//
// job 상태 흐름(다른 파이프라인이 이 job을 집지 않게 고른 값 - docs/ai-handoff/SCENEPICK_CODEX.md "제외 선택"):
//   접수(텔레그램)  status=selected  + scenepickCodex.requested   -> triggerResearch를 부르지 않으므로 조사·집필 큐에 안 들어간다
//   완료            status=approved  + channelManuscriptsReadyAt  -> 원고 준비(listApprovedWithoutManuscript)가 "이미 준비됨"으로 건너뛴다
//   실패            status=rejected  + rejectedAt                 -> 끝난 job. 다시 보내면 새 job으로 발주한다
//
// 모든 바깥 동작은 deps로 주입한다 - 테스트는 DB·codex·Storage·텔레그램 없이 돈다.
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import type { ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import type { RunCodexWorkspaceOptions, RunCodexWorkspaceResult } from "../../services/llm/runCodexWorkspace.js";
import type { UploadArticleImageInput, UploadArticleImageResult } from "../../services/supabase/storage/uploadArticleImage.js";
import { buildScenepickEntry } from "./buildScenepickEntry.js";
import type { UploadedScenepickImage } from "./buildScenepickEntry.js";
import { buildScenepickFixPrompt, buildScenepickPrompt, scenepickOutputDir } from "./scenepickPrompt.js";
import { patchScenepickState } from "./scenepickQueue.js";
import type { ScenepickQueueDeps } from "./scenepickQueue.js";
import { kstDateString, readScenepickState } from "./scenepickTypes.js";
import type { ScenepickCodexState } from "./scenepickTypes.js";
import type { ScenepickValidation } from "./validateScenepickDelivery.js";

/** Codex 호출 상한(첫 발주 + 재작업 1회). */
export const MAX_CODEX_RUNS = 2;

/** 저장소의 상시 지침 원본. 매 실행 전에 작업장 루트로 복사한다(작업장에서 고치면 다음 실행에 덮인다). */
export const AGENTS_SOURCE_PATH = fileURLToPath(new URL("../../../codex/scenepick/AGENTS.md", import.meta.url));

/** 작업장 위치. 저장소 밖의 독립 폴더다(Codex workspace-write가 저장소를 건드리지 못하게). `package/`는 사용자 문체 패키지 - 절대 지우거나 덮지 않는다. */
export function scenepickWorkspace(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SCENEPICK_WORKSPACE?.trim();
  if (!raw) return join(homedir(), "blog-automation", "scenepick-workspace");
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(raw);
}

export type ScenepickJobLike = { id: string; keyword: string; metadata: Record<string, unknown> | null };

export type ScenepickRunDeps = {
  findJob: (jobId: string) => Promise<ScenepickJobLike | null>;
  queue?: ScenepickQueueDeps;
  /** 상태 외 metadata 병합(channelManuscriptsReadyAt·rejectedAt). */
  mergeMetadata: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  updateStatus: (jobId: string, status: "approved" | "rejected") => Promise<unknown>;
  runCodex: (options: RunCodexWorkspaceOptions) => Promise<RunCodexWorkspaceResult>;
  validate: (dir: string) => Promise<ScenepickValidation>;
  uploadImage: (input: UploadArticleImageInput) => Promise<UploadArticleImageResult>;
  /** 뷰어 manifest에 **이 원고 한 행만** 저장한다(전체 저장은 8초 statement timeout에 걸린다 - 2026-11-20). */
  saveTopic: (topic: ManuscriptTopicEntry) => Promise<void>;
  dispatchRefresh: () => Promise<"dispatched" | "no_token">;
  pageUrlFor: (jobId: string) => string | null;
  notify: (job: ScenepickJobLike, text: string, pageUrl: string | null) => Promise<void>;
  workspace?: string;
  agentsSourcePath?: string;
  now?: () => Date;
};

export type ScenepickRunResult =
  | { status: "done"; title: string; category: string; imageCount: number; attempts: number; refresh: string }
  | { status: "failed"; error: string; authRequired: boolean }
  | { status: "skipped"; reason: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 실패 사유를 텔레그램 한 줄로. 검사 항목이 여럿이면 앞 두 개만. */
export function shortReason(failures: readonly string[]): string {
  if (failures.length === 0) return "원인 미상";
  const head = failures.slice(0, 2).join(" / ");
  return failures.length > 2 ? `${head} 외 ${failures.length - 2}건` : head;
}

export function doneMessage(input: { title: string; category: string; imageCount: number; pageUrl: string | null; fallbackPath: string }): string {
  return [
    `✅ 원고 준비 완료 — ${escapeTelegramHtml(input.title)}`,
    `카테고리: ${escapeTelegramHtml(input.category)} · 이미지 ${input.imageCount}장`,
    input.pageUrl ? escapeTelegramHtml(input.pageUrl) : `원고 페이지 주소를 만들 수 없습니다(CLOUDFLARE_PAGES_PROJECT_NAME) - 작업장: ${escapeTelegramHtml(input.fallbackPath)}`,
  ].join("\n");
}

export function failedMessage(keyword: string, reason: string): string {
  return [`⚠️ 원고 발주 실패 — ${escapeTelegramHtml(keyword)}`, `원인: ${escapeTelegramHtml(reason)}`, "다시 보내면 새로 발주합니다."].join("\n");
}

export async function runScenepickJob(jobId: string, deps: ScenepickRunDeps, options: { force?: boolean } = {}): Promise<ScenepickRunResult> {
  const now = deps.now ?? (() => new Date());
  const startedMs = now().getTime();
  const job = await deps.findJob(jobId);
  if (!job) return { status: "skipped", reason: "job_not_found" };
  let state = readScenepickState(job.metadata);
  if (!state) return { status: "skipped", reason: "not_a_scenepick_job" };
  if (!options.force && (state.status === "done" || state.status === "failed")) return { status: "skipped", reason: `already_${state.status}` };
  if (options.force) {
    // 수동 재실행: 회차를 처음부터 센다. 납품 폴더는 지우지 않는다 - 이미 통과하는 납품이 있으면 그대로 받는다.
    state = (await patchScenepickState(jobId, { status: "running", attempts: 0, failures: [], error: undefined, finishedAt: undefined, heartbeatAt: now().toISOString() }, deps.queue)) ?? state;
  }

  const topic = typeof job.metadata?.inputTopic === "string" && job.metadata.inputTopic.trim() ? job.metadata.inputTopic : job.keyword;
  const workspace = deps.workspace ?? scenepickWorkspace();
  const outputRel = scenepickOutputDir(jobId);
  const outputDir = join(workspace, outputRel);
  let tokensUsed = state.tokensUsed ?? 0;

  const fail = async (error: string, authRequired = false): Promise<ScenepickRunResult> => {
    const finishedAt = now().toISOString();
    await patchScenepickState(
      jobId,
      { status: "failed", error, finishedAt, durationSec: Math.round((now().getTime() - startedMs) / 1000), ...(tokensUsed ? { tokensUsed } : {}) },
      deps.queue
    );
    await deps.mergeMetadata(jobId, { rejectedAt: finishedAt });
    await deps.updateStatus(jobId, "rejected");
    await deps.notify(job, failedMessage(job.keyword, error), null).catch((notifyError) => {
      console.error(`⚠️ [scenepick] 실패 알림 발송 실패: ${notifyError instanceof Error ? notifyError.message : notifyError}`);
    });
    return { status: "failed", error, authRequired };
  };

  // 1) 작업장: 상시 지침 복사(매번 - 저장소가 원본), 납품 폴더 준비. package/ 등 다른 것은 손대지 않는다.
  const agentsSource = deps.agentsSourcePath ?? AGENTS_SOURCE_PATH;
  if (!(await exists(agentsSource))) {
    return fail(`발주 지침 파일이 없습니다(${agentsSource}) - 맥미니 저장소에서 git pull 후 다시 보내 주세요`);
  }
  await mkdir(outputDir, { recursive: true });
  await copyFile(agentsSource, join(workspace, "AGENTS.md"));

  const order = { jobId, topic, outputDir: outputRel, today: kstDateString(now()) };
  let failures: string[] = state.failures ?? [];
  let attempts = state.attempts;

  // 2) 잔재 재집기: 앞선 실행이 납품을 끝내 놓고 죽었을 수 있다(맥 잠들기 등) - Codex를 다시 부르기 전에 한 번 본다.
  let validation: ScenepickValidation | null = attempts > 0 ? await deps.validate(outputDir) : null;

  while (!validation?.ok && attempts < MAX_CODEX_RUNS) {
    const prompt =
      attempts === 0
        ? buildScenepickPrompt(order)
        : buildScenepickFixPrompt({ ...order, failures: failures.length > 0 ? failures : ["앞선 실행이 끝나지 않고 중단됐습니다 - 납품물을 완성"] });
    attempts += 1;
    await patchScenepickState(jobId, { attempts, heartbeatAt: now().toISOString() }, deps.queue);
    console.log(`▶ [scenepick] ${jobId.slice(0, 8)} Codex ${attempts}회차 (${attempts === 1 ? "발주" : "재작업"})`);

    const run = await deps.runCodex({ prompt, workspace });
    tokensUsed += run.tokensUsed ?? 0;
    if (!run.ok && run.authRequired) return fail(run.error, true);

    validation = await deps.validate(outputDir);
    if (validation.ok) break;
    // Codex가 오류로 끝났어도 납품이 통과하면 받는다(위). 둘 다 실패면 실행 오류를 맨 앞에 둔다.
    failures = run.ok ? validation.failures : [`codex 실행 오류: ${run.error}`, ...validation.failures];
    await patchScenepickState(jobId, { failures, ...(tokensUsed ? { tokensUsed } : {}) }, deps.queue);
    console.warn(`⚠️ [scenepick] ${jobId.slice(0, 8)} ${attempts}회차 형식 검사 실패: ${failures.join(" | ")}`);
  }

  if (!validation?.ok) return fail(shortReason(failures));
  const delivery = validation.delivery;

  // 3) 이미지 업로드(article-images/<jobId>/<index>.ext). 사진·일러스트는 WebP로 줄이고, 도해는 글자가 뭉개지지 않게 화질을 올린다.
  const uploads: UploadedScenepickImage[] = [];
  for (const image of delivery.images) {
    const result = await deps.uploadImage({
      jobId,
      index: image.index,
      imageBuffer: await readFile(image.path),
      mimeType: image.mimeType,
      optimize: image.method === "diagram" ? { quality: 0.9 } : true,
    });
    if (!result.ok) return fail(`이미지 ${image.index} 업로드 실패: ${result.error}`);
    uploads.push({ index: image.index, url: result.url, extension: result.extension ?? "png", width: result.width ?? null, height: result.height ?? null });
  }

  // 4) 뷰어 행 저장 -> job 마감. 순서가 중요하다: channelManuscriptsReadyAt을 먼저 적고 status를 approved로 바꾼다 -
  //    반대로 하면 그 사이 원고 준비(job-publish-prepare)가 "승인됐는데 준비 안 된 job"으로 집어 우리 writer 경로를 탄다.
  const readyAt = now().toISOString();
  const entry = buildScenepickEntry({
    jobId,
    keyword: job.keyword,
    delivery,
    uploads,
    readyAt,
    date: kstDateString(now()),
    filePath: `scenepick-workspace/${outputRel}/manuscript.md`,
  });
  await deps.saveTopic(entry);
  await deps.mergeMetadata(jobId, { channelManuscriptsReadyAt: readyAt });
  const finished: Partial<ScenepickCodexState> = {
    status: "done",
    finishedAt: readyAt,
    failures: [],
    durationSec: Math.round((now().getTime() - startedMs) / 1000),
    ...(tokensUsed ? { tokensUsed } : {}),
    title: delivery.title,
    category: delivery.category,
    imageCount: delivery.images.length,
  };
  await patchScenepickState(jobId, finished, deps.queue);
  await deps.updateStatus(jobId, "approved");

  // 5) 페이지 재배포 발화(실패해도 원고는 저장됐다 - 다음 배포에 실린다) -> 알림.
  let refresh: string;
  try {
    refresh = await deps.dispatchRefresh();
  } catch (error) {
    refresh = `failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`⚠️ [scenepick] manuscripts-refresh 발화 실패: ${refresh}`);
  }
  const pageUrl = deps.pageUrlFor(jobId);
  await deps
    .notify(job, doneMessage({ title: delivery.title, category: delivery.category, imageCount: delivery.images.length, pageUrl, fallbackPath: outputDir }), pageUrl)
    .catch((error) => console.error(`⚠️ [scenepick] 완료 알림 발송 실패: ${error instanceof Error ? error.message : error}`));

  return { status: "done", title: delivery.title, category: delivery.category, imageCount: delivery.images.length, attempts, refresh };
}
