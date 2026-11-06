// heavy-pipeline(job-research.yml/job-write.yml/job-revise.yml) 디스패치 순서를 GitHub Actions
// concurrency 큐가 아니라 여기서 직접 관리한다. 자세한 배경은
// supabase/migrations/20260916060000_pipeline_dispatch_queue.sql 상단 주석 참고 - 요약하면
// GH Actions의 concurrency 큐는 "실행 중 1개 + 대기 1개"까지만 허용하고 그 이상이 들어오면 대기
// 중이던 실행을 경고 없이 취소한다. dispatchWorkflow.ts의 "대기 후 디스패치" 완화책(2026-09-15)도
// 대기 상한(3~5분)이 실제 소요 시간(15~25분)보다 훨씬 짧아 실측에서 계속 뚫렸다(09-15/09-16
// 이틀 연속 원고 유실).
//
// 설계: pipeline_lock(싱글턴 뮤텍스) 행의 is_busy를 false->true로 바꾸는 조건부 UPDATE는
// Postgres 행 잠금으로 원자적이라, 여러 프로세스가 동시에 시도해도 정확히 하나만 성공한다(SQL
// 레벨 compare-and-swap - 별도 advisory lock이 필요 없다). 그래서:
//   - enqueueAndMaybeDispatch: 큐에 pending 행을 쌓고, 락을 딸 수 있으면(=지금 아무것도 안 돌고
//     있으면) 즉시 디스패치까지 한다.
//   - markDoneAndDrain: 워크플로우 실행이 끝날 때(성공/실패 무관, 호출부가 always() 스텝에서
//     부른다) 자기 행을 done/failed로 남기고 락을 풀고, 곧바로 다음 pending 항목을 스스로
//     깨운다 - 대기 인원이 몇 명이든 GitHub 큐의 "대기 1개" 한도에 안 걸리고 순서대로 처리된다.
//
// 안전장치: 러너가 비정상 종료(하드 타임아웃 강제 종료 등)돼 markDoneAndDrain이 끝내 호출되지
// 못하면 락이 영원히 안 풀릴 수 있다 - locked_at이 STALE_LOCK_MS를 넘기면 다음 시도가 "오래된
// 락"으로 보고 강제로 회수한다(heavyPipelineLock.ts의 staleMs와 같은 철학).

import { supabase } from "../supabase/client.js";
import type { PipelineDispatchQueueRow, PipelineQueueStatus } from "../../types/database.js";

/** job-research(18분)·job-write(20분)보다 넉넉히 길게 - 정상 실행 중인 락을 stale로 잘못 가로채면 안 된다. */
const STALE_LOCK_MS = 30 * 60 * 1000;

export type EnqueueInput = {
  jobId: string;
  workflowFile: string;
  inputs?: Record<string, string>;
};

/** 테스트 주입 지점. 기본은 실제 supabase 클라이언트 + GitHub API + Telegram. */
export type PipelineQueueDeps = {
  supabaseClient?: typeof supabase;
  dispatchToGithub?: (input: { workflowFile: string; inputs: Record<string, string> }) => Promise<void>;
  now?: () => Date;
  /** 큐 행이 failed로 끝났을 때의 알림. 테스트에서 주입한다. */
  notifyFailure?: (input: QueueFailureNotice) => Promise<void>;
};

export type QueueFailureNotice = {
  jobId: string | null;
  workflowFile: string | null;
  /** "stale_lock_recovered"면 워크플로우가 **시작조차 못 한** 경우다(GH가 대기 중에 취소). */
  error: string;
};

/**
 * 큐 실패를 사용자에게 알린다(2026-11-02 신설).
 *
 * 왜: 그 전까지 큐 실패는 **DB에만 적히고 아무에게도 안 갔다.** 11/01 "하트 오브 비스트"가 Go를
 * 연달아 누른 탓에 GitHub concurrency 큐에서 취소됐는데(대기 2개 초과), 워크플로우가 시작조차
 * 못 해 `always()` 마감 스텝도 안 돌았고, 40분 뒤 stale-lock 회수가 조용히 failed로 적었다.
 * 사용자는 **24시간 뒤에야** 원고가 안 왔다는 걸 알았다. 발행 실패는 알림이 가는데 조사·집필
 * 큐 실패는 안 가던 비대칭을 없앤다.
 *
 * 이 함수는 **절대 예외를 던지지 않는다** - 알림 실패가 큐 배수(drain)를 막으면 파이프라인 전체가
 * 멈춘다(notifyPipelineFailure와 같은 원칙).
 */
async function defaultNotifyQueueFailure(input: QueueFailureNotice): Promise<void> {
  try {
    if (!input.jobId) return;
    const [{ notifierForJobId }, { ArticleJobRepository }, { escapeTelegramHtml }] = await Promise.all([
      import("../../notifications/notifierForJob.js"),
      import("../../repositories/ArticleJobRepository.js"),
      import("../../notifications/TelegramNotifier.js"),
    ]);
    const job = await ArticleJobRepository.findById(input.jobId).catch(() => null);
    const notifier = await notifierForJobId(input.jobId);
    const stage = input.workflowFile?.replace(/^job-|\.yml$/g, "") ?? "파이프라인";
    const neverStarted = input.error === "stale_lock_recovered";
    await notifier.sendMessages([
      {
        text: [
          `⚠️ <b>${escapeTelegramHtml(stage)} 단계가 끝내 실패했습니다</b>`,
          "",
          `<b>${escapeTelegramHtml(job?.keyword ?? input.jobId)}</b>`,
          neverStarted
            ? "워크플로우가 시작되지 못했습니다(동시 실행이 몰려 취소됐을 수 있습니다)."
            : escapeTelegramHtml(input.error),
          "",
          "자동 재시도는 없습니다 - 키워드 버튼을 다시 눌러주세요.",
        ].join("\n"),
      },
    ]);
  } catch (error) {
    console.warn(`⚠️ [pipeline-queue] 실패 알림 발송 실패(무시하고 계속): ${(error as Error).message}`);
  }
}

async function releaseStaleLockIfAny(db: typeof supabase, now: () => Date, deps: PipelineQueueDeps = {}): Promise<void> {
  const { data: lock } = await db.from("pipeline_lock").select("*").eq("id", 1).maybeSingle();
  if (!lock?.is_busy || !lock.locked_at) return;

  const age = now().getTime() - new Date(lock.locked_at).getTime();
  if (age <= STALE_LOCK_MS) return;

  console.warn(
    `⚠️ [pipeline-queue] 락이 ${Math.round(age / 60000)}분째 안 풀려 있어 강제 회수합니다 ` +
      `(queue_id=${lock.current_queue_id ?? "?"}) - 러너가 비정상 종료됐을 수 있습니다.`
  );
  // 붙잡고 있던 큐 행도 실패로 남겨야 다음 조회에서 다시 걸리지 않는다.
  if (lock.current_queue_id) {
    const { data: stale } = await db
      .from("pipeline_dispatch_queue")
      .select("job_id, workflow_file, status")
      .eq("id", lock.current_queue_id)
      .maybeSingle();
    const { data: updated } = await db
      .from("pipeline_dispatch_queue")
      .update({ status: "failed", finished_at: now().toISOString(), error: "stale_lock_recovered" })
      .eq("id", lock.current_queue_id)
      .eq("status", "dispatched")
      .select("id");
    // 실제로 failed로 바꾼 경우에만 알린다(이미 마감된 행이면 중복 알림을 보내지 않는다).
    if (updated && updated.length > 0) {
      await (deps.notifyFailure ?? defaultNotifyQueueFailure)({
        jobId: (stale?.job_id as string | null) ?? null,
        workflowFile: (stale?.workflow_file as string | null) ?? null,
        error: "stale_lock_recovered",
      });
    }
  }
  await db.from("pipeline_lock").update({ is_busy: false, current_queue_id: null, locked_at: null }).eq("id", 1);
}

/** 락을 딸 수 있으면(=지금 아무것도 안 돌고 있으면) pending 중 가장 오래된 항목을 디스패치한다. */
export async function tryDispatchNext(deps: PipelineQueueDeps = {}): Promise<void> {
  const db = deps.supabaseClient ?? supabase;
  const now = deps.now ?? (() => new Date());
  const dispatchToGithub = deps.dispatchToGithub ?? defaultDispatchToGithub;

  await releaseStaleLockIfAny(db, now, deps);

  const acquired = await db
    .from("pipeline_lock")
    .update({ is_busy: true, locked_at: now().toISOString() })
    .eq("id", 1)
    .eq("is_busy", false)
    .select();
  if (!acquired.data || acquired.data.length === 0) {
    // 이미 다른 무언가가 돌고 있다 - 그게 끝날 때 markDoneAndDrain이 알아서 다음을 깨운다.
    return;
  }

  const { data: next } = await db
    .from("pipeline_dispatch_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!next) {
    // 딸 건 땄는데 쌓인 게 없다 - 바로 놓아준다(idle).
    await db.from("pipeline_lock").update({ is_busy: false, locked_at: null }).eq("id", 1);
    return;
  }

  await db
    .from("pipeline_dispatch_queue")
    .update({ status: "dispatched", dispatched_at: now().toISOString() })
    .eq("id", next.id);
  await db.from("pipeline_lock").update({ current_queue_id: next.id }).eq("id", 1);

  try {
    await dispatchToGithub({
      workflowFile: next.workflow_file,
      inputs: { ...next.inputs, job_id: next.job_id, queue_id: String(next.id) },
    });
  } catch (error) {
    // GitHub API 호출 자체가 실패했다 - 이 항목은 실패로 남기고 락을 풀어 다음 항목이라도
    // 진행되게 한다(markDoneAndDrain과 동일한 해제 경로를 타지 않으므로 여기서 직접 처리).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️ [pipeline-queue] workflow_dispatch 실패(${next.workflow_file}):`, message);
    await db
      .from("pipeline_dispatch_queue")
      .update({ status: "failed", finished_at: now().toISOString(), error: message })
      .eq("id", next.id);
    await db.from("pipeline_lock").update({ is_busy: false, current_queue_id: null, locked_at: null }).eq("id", 1);

    // 2026-11-06: 디스패치 호출 자체가 실패한 경우도 사용자에게 알린다. 2026-11-05 16:10 UTC에 GitHub 500으로
    // 사용설명서 Go 2건이 죽었는데 이 분기만 알림이 빠져 있어 아무도 몰랐다(11/01 사고와 같은 모양).
    // **락을 푼 뒤에** 보낸다 - 락을 쥔 채 알림을 기다리다 막히면 파이프라인 전체가 선다.
    try {
      await (deps.notifyFailure ?? defaultNotifyQueueFailure)({
        jobId: (next.job_id as string | null) ?? null,
        workflowFile: (next.workflow_file as string | null) ?? null,
        error: message,
      });
    } catch (notifyError) {
      // 기본 구현은 던지지 않지만 주입된 구현은 모른다 - 알림 실패가 호출부로 번지면 안 된다.
      console.warn(`⚠️ [pipeline-queue] 실패 알림 발송 실패(무시하고 계속): ${(notifyError as Error).message}`);
    }
  }
}

/** 큐에 쌓고, 지금 비어 있으면 곧바로 디스패치까지 시도한다. */
export async function enqueueAndMaybeDispatch(input: EnqueueInput, deps: PipelineQueueDeps = {}): Promise<void> {
  const db = deps.supabaseClient ?? supabase;
  const { error } = await db.from("pipeline_dispatch_queue").insert({
    job_id: input.jobId,
    workflow_file: input.workflowFile,
    inputs: input.inputs ?? {},
  });
  if (error) throw error;

  await tryDispatchNext(deps);
}

/**
 * 워크플로우 실행이 끝났을 때(성공/실패 무관) 호출한다 - job-research.yml/job-write.yml/
 * job-revise.yml의 마지막 스텝(`if: always()`)이 부른다. 자기 행을 마감 처리하고, 락을 풀고,
 * 곧바로 다음 pending 항목을 스스로 깨운다(체인).
 */
export async function markDoneAndDrain(
  queueId: number,
  outcome: Extract<PipelineQueueStatus, "done" | "failed">,
  deps: PipelineQueueDeps & { error?: string } = {}
): Promise<void> {
  const db = deps.supabaseClient ?? supabase;
  const now = deps.now ?? (() => new Date());

  // 알림에 쓸 job·workflow를 **지우기 전에** 읽어 둔다.
  const { data: row } = await db
    .from("pipeline_dispatch_queue")
    .select("job_id, workflow_file")
    .eq("id", queueId)
    .maybeSingle();

  await db
    .from("pipeline_dispatch_queue")
    .update({ status: outcome, finished_at: now().toISOString(), error: deps.error ?? null })
    .eq("id", queueId);

  // 2026-11-02: 실패는 사용자에게 알린다. 그 전까지 DB에만 적혀 아무도 몰랐다(머리말 참고).
  if (outcome === "failed") {
    await (deps.notifyFailure ?? defaultNotifyQueueFailure)({
      jobId: (row?.job_id as string | null) ?? null,
      workflowFile: (row?.workflow_file as string | null) ?? null,
      error: deps.error ?? "워크플로우가 실패로 끝났습니다.",
    });
  }

  // 이 큐 행을 잡고 있던 락일 때만 놓는다 - stale-lock 회수가 이미 먼저 풀었을 수도 있어(그 경우
  // current_queue_id가 다르거나 null) 조건을 맞춰서만 갱신한다(이중 해제 방지).
  await db
    .from("pipeline_lock")
    .update({ is_busy: false, current_queue_id: null, locked_at: null })
    .eq("id", 1)
    .eq("current_queue_id", queueId);

  await tryDispatchNext(deps);
}

async function defaultDispatchToGithub(input: { workflowFile: string; inputs: Record<string, string> }): Promise<void> {
  const { dispatchGithubWorkflow } = await import("./dispatchWorkflow.js");
  await dispatchGithubWorkflow({ workflowFile: input.workflowFile, inputs: input.inputs });
}

export type { PipelineDispatchQueueRow };
