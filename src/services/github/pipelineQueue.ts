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

/** 테스트 주입 지점. 기본은 실제 supabase 클라이언트 + GitHub API. */
export type PipelineQueueDeps = {
  supabaseClient?: typeof supabase;
  dispatchToGithub?: (input: { workflowFile: string; inputs: Record<string, string> }) => Promise<void>;
  now?: () => Date;
};

async function releaseStaleLockIfAny(db: typeof supabase, now: () => Date): Promise<void> {
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
    await db
      .from("pipeline_dispatch_queue")
      .update({ status: "failed", finished_at: now().toISOString(), error: "stale_lock_recovered" })
      .eq("id", lock.current_queue_id)
      .eq("status", "dispatched");
  }
  await db.from("pipeline_lock").update({ is_busy: false, current_queue_id: null, locked_at: null }).eq("id", 1);
}

/** 락을 딸 수 있으면(=지금 아무것도 안 돌고 있으면) pending 중 가장 오래된 항목을 디스패치한다. */
export async function tryDispatchNext(deps: PipelineQueueDeps = {}): Promise<void> {
  const db = deps.supabaseClient ?? supabase;
  const now = deps.now ?? (() => new Date());
  const dispatchToGithub = deps.dispatchToGithub ?? defaultDispatchToGithub;

  await releaseStaleLockIfAny(db, now);

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

  await db
    .from("pipeline_dispatch_queue")
    .update({ status: outcome, finished_at: now().toISOString(), error: deps.error ?? null })
    .eq("id", queueId);

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
