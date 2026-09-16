// pipelineQueue 오케스트레이션 테스트. 실제 Supabase/GitHub 호출 없이 인메모리 스텁으로
// enqueue -> dispatch -> markDone -> 다음 항목 자동 체인을 검증한다.
import { enqueueAndMaybeDispatch, markDoneAndDrain, tryDispatchNext } from "./pipelineQueue.js";
import type { PipelineDispatchQueueRow, PipelineLockRow, PipelineQueueStatus } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/**
 * 아주 작은 인메모리 Supabase 흉내. pipelineQueue.ts가 실제로 쓰는 체이닝(.from().select()...
 * .eq()...)만 지원한다 - 범용 목이 아니다.
 */
function makeFakeDb() {
  let nextId = 1;
  const queue: PipelineDispatchQueueRow[] = [];
  const lock: PipelineLockRow = { id: 1, is_busy: false, current_queue_id: null, locked_at: null };

  function queueTable() {
    const api = {
      _filters: [] as Array<(r: PipelineDispatchQueueRow) => boolean>,
      _order: null as null | { asc: boolean },
      _limit: null as number | null,
      _pendingUpdate: null as null | Partial<PipelineDispatchQueueRow>,
      insert(row: Partial<PipelineDispatchQueueRow>) {
        queue.push({
          id: nextId++,
          job_id: row.job_id!,
          workflow_file: row.workflow_file!,
          inputs: row.inputs ?? {},
          status: "pending",
          created_at: new Date().toISOString(),
          dispatched_at: null,
          finished_at: null,
          error: null,
        });
        return Promise.resolve({ error: null });
      },
      select() {
        return api;
      },
      eq(field: keyof PipelineDispatchQueueRow, value: unknown) {
        api._filters.push((r) => r[field] === value);
        return api;
      },
      order(_field: string, opts: { ascending: boolean }) {
        api._order = { asc: opts.ascending };
        return api;
      },
      limit(n: number) {
        api._limit = n;
        return api;
      },
      update(patch: Partial<PipelineDispatchQueueRow>) {
        api._pendingUpdate = patch;
        return api;
      },
      async maybeSingle() {
        let rows = queue.filter((r) => api._filters.every((f) => f(r)));
        if (api._order) rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        return { data: rows[0] ?? null };
      },
      then(resolve: (v: { data: PipelineDispatchQueueRow[] | null; error: null }) => void) {
        // update(...).eq(...) 체인의 마지막(await 대상)으로 쓰인다.
        if (api._pendingUpdate) {
          for (const row of queue) {
            if (api._filters.every((f) => f(row))) Object.assign(row, api._pendingUpdate);
          }
        }
        resolve({ data: [], error: null });
      },
    };
    return api;
  }

  function lockTable() {
    const filters: Array<(r: PipelineLockRow) => boolean> = [];
    let pendingUpdate: Partial<PipelineLockRow> | null = null;

    /** 조건에 맞으면 대기 중인 update를 적용하고, 매치 여부를 돌려준다(CAS 판정 + 적용을 한 번에). */
    function applyIfMatched(): boolean {
      const matched = filters.every((f) => f(lock));
      if (matched && pendingUpdate) Object.assign(lock, pendingUpdate);
      return matched;
    }

    const api = {
      select() {
        // update(...).eq(...)... 뒤에 오면 CAS 결과 확인용(원자적 조건부 갱신이 실제로 몇 행에
        // 적용됐는지 반환) - 아직 update가 없으면 읽기 체인의 시작(select("*").eq(...).maybeSingle()).
        if (pendingUpdate) {
          const matched = applyIfMatched();
          return { then: (resolve: (v: { data: PipelineLockRow[] }) => void) => resolve({ data: matched ? [{ ...lock }] : [] }) };
        }
        return api;
      },
      eq(field: keyof PipelineLockRow, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      update(patch: Partial<PipelineLockRow>) {
        pendingUpdate = patch;
        return api;
      },
      async maybeSingle() {
        return { data: filters.every((f) => f(lock)) ? { ...lock } : null };
      },
      // select() 없이 update(...).eq(...)를 바로 await하는 경우(반환값을 안 쓰는 호출) -
      // 여기서도 반드시 적용해야 한다. 실 Supabase에서는 update가 항상 즉시 반영되는 것과 대응.
      then(resolve: (v: { data: null }) => void) {
        applyIfMatched();
        resolve({ data: null });
      },
    };
    return api;
  }

  const db = {
    from(table: string) {
      if (table === "pipeline_dispatch_queue") return queueTable();
      if (table === "pipeline_lock") return lockTable();
      throw new Error(`알 수 없는 테이블: ${table}`);
    },
  };

  return { db: db as never, queue, lock };
}

async function main(): Promise<void> {
  console.log("▶ pipelineQueue 테스트 시작\n");

  // 1) 비어 있을 때 enqueue -> 즉시 디스패치된다(락을 곧바로 딸 수 있으므로).
  {
    const { db, queue, lock } = makeFakeDb();
    const dispatched: string[] = [];
    await enqueueAndMaybeDispatch(
      { jobId: "job-1", workflowFile: "job-research.yml" },
      { supabaseClient: db, dispatchToGithub: async (i) => void dispatched.push(i.workflowFile) }
    );
    assert(dispatched.length === 1, `비어 있으면 즉시 디스패치돼야 한다 (실제: ${dispatched.length}회)`);
    assert(queue[0]!.status === "dispatched", "행 상태가 dispatched로 바뀌어야 한다");
    assert(lock.is_busy === true, "디스패치 중에는 락이 잡혀 있어야 한다");
    console.log("✅ 비어 있을 때 enqueue -> 즉시 디스패치 + 락 획득");
  }

  // 2) 이미 뭔가 돌고 있으면(락 잡힘) enqueue는 쌓이기만 하고 디스패치되지 않는다 - 바로 이 지점이
  //    "대기 1개 넘으면 GitHub이 조용히 취소"하던 버그를 원천적으로 막는다.
  {
    const { db, queue } = makeFakeDb();
    const dispatched: string[] = [];
    const deps = { supabaseClient: db, dispatchToGithub: async (i: { workflowFile: string }) => void dispatched.push(i.workflowFile) };

    await enqueueAndMaybeDispatch({ jobId: "job-1", workflowFile: "job-research.yml" }, deps); // 1번째: 즉시 디스패치
    await enqueueAndMaybeDispatch({ jobId: "job-2", workflowFile: "job-research.yml" }, deps); // 2번째: 대기
    await enqueueAndMaybeDispatch({ jobId: "job-3", workflowFile: "job-research.yml" }, deps); // 3번째: 대기
    await enqueueAndMaybeDispatch({ jobId: "job-4", workflowFile: "job-research.yml" }, deps); // 4번째: 대기(취소 없음!)

    assert(dispatched.length === 1, `1개만 즉시 디스패치돼야 한다 (실제: ${dispatched.length}회)`);
    const statuses = queue.map((r) => r.status);
    assert(
      statuses.filter((s) => s === "pending").length === 3,
      `나머지 3개는 취소되지 않고 pending으로 쌓여야 한다 (실제: ${JSON.stringify(statuses)})`
    );
    console.log("✅ 실행 중에 여러 건 enqueue -> 취소 없이 전부 대기(pending)로 쌓임");
  }

  // 3) markDoneAndDrain: 끝나면 락을 풀고 곧바로 다음 pending을 스스로 디스패치한다(체인).
  {
    const { db, queue } = makeFakeDb();
    const dispatched: string[] = [];
    // TS가 `dispatched.length === N` 연속 비교를 리터럴 타입으로 좁혀버려(push는 함수 호출 너머라
    // 못 따라간다) 다음 비교와 충돌한다 - 함수로 한 겹 감싸 매번 새로 읽게 한다.
    const count = () => dispatched.length;
    const deps = { supabaseClient: db, dispatchToGithub: async (i: { workflowFile: string }) => void dispatched.push(i.workflowFile) };

    await enqueueAndMaybeDispatch({ jobId: "job-1", workflowFile: "job-research.yml" }, deps);
    await enqueueAndMaybeDispatch({ jobId: "job-2", workflowFile: "job-research.yml" }, deps);
    await enqueueAndMaybeDispatch({ jobId: "job-3", workflowFile: "job-research.yml" }, deps);
    assert(count() === 1, "사전조건: 1개만 디스패치된 상태여야 한다");

    const firstDispatchedId = queue.find((r) => r.status === "dispatched")!.id;
    await markDoneAndDrain(firstDispatchedId, "done", deps);

    assert(count() === 2, `1번이 끝나면 곧바로 2번이 디스패치돼야 한다 (실제: ${count()}회)`);
    assert(queue.find((r) => r.id === firstDispatchedId)!.status === "done", "끝난 행은 done으로 남아야 한다");
    const secondDispatchedId = queue.find((r) => r.status === "dispatched")!.id;
    await markDoneAndDrain(secondDispatchedId, "done", deps);
    assert(count() === 3, `2번이 끝나면 3번까지 순서대로 디스패치돼야 한다 (실제: ${count()}회)`);
    console.log("✅ markDoneAndDrain -> 락 해제 + 다음 pending 자동 디스패치(체인), 순서 보존");
  }

  // 4) 디스패치 순서는 created_at(먼저 쌓인 순서) 기준이어야 한다(FIFO).
  {
    const { db, queue } = makeFakeDb();
    const dispatchedJobIds: string[] = [];
    const deps = {
      supabaseClient: db,
      dispatchToGithub: async (i: { inputs: Record<string, string> }) => void dispatchedJobIds.push(i.inputs.job_id),
    };
    await enqueueAndMaybeDispatch({ jobId: "first", workflowFile: "job-research.yml" }, deps);
    await enqueueAndMaybeDispatch({ jobId: "second", workflowFile: "job-research.yml" }, deps);
    await enqueueAndMaybeDispatch({ jobId: "third", workflowFile: "job-research.yml" }, deps);

    let dispatchedId = queue.find((r) => r.status === "dispatched")!.id;
    await markDoneAndDrain(dispatchedId, "done", deps);
    dispatchedId = queue.find((r) => r.status === "dispatched")!.id;
    await markDoneAndDrain(dispatchedId, "done", deps);

    assert(
      dispatchedJobIds.join(",") === "first,second,third",
      `FIFO 순서로 디스패치돼야 한다 (실제: ${dispatchedJobIds.join(",")})`
    );
    console.log("✅ 먼저 쌓인 순서(FIFO)대로 디스패치");
  }

  // 5) GitHub API 호출 자체가 실패해도 락이 풀려 다음 항목이 진행된다(영구 정지 방지).
  {
    const { db, queue } = makeFakeDb();
    const dispatched: string[] = [];
    let calls = 0;
    const deps = {
      supabaseClient: db,
      dispatchToGithub: async (i: { workflowFile: string }) => {
        calls += 1;
        if (calls === 1) throw new Error("네트워크 오류");
        dispatched.push(i.workflowFile);
      },
    };
    await enqueueAndMaybeDispatch({ jobId: "job-1", workflowFile: "job-research.yml" }, deps);
    assert(queue[0]!.status === "failed", "디스패치 자체가 실패하면 그 행은 failed로 남아야 한다");
    assert(queue[0]!.error?.includes("네트워크"), "실패 사유가 기록돼야 한다");

    await enqueueAndMaybeDispatch({ jobId: "job-2", workflowFile: "job-research.yml" }, deps);
    assert(dispatched.length === 1, "이전 디스패치 실패로 락이 안 풀렸다면 다음 항목이 진행되지 않는다 - 그러면 안 된다");
    console.log("✅ workflow_dispatch API 실패 -> 해당 행 failed + 락 해제(다음 항목 진행)");
  }

  // 6) 오래된(stale) 락은 다음 시도에서 자동 회수된다 - 러너 강제 종료 등으로 markDoneAndDrain이
  //    끝내 안 불려도 영구 정지하지 않는다.
  {
    const { db, queue, lock } = makeFakeDb();
    const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40분 전(30분 상한 초과)
    queue.push({
      id: 1,
      job_id: "stuck-job",
      workflow_file: "job-research.yml",
      inputs: {},
      status: "dispatched",
      created_at: staleTime,
      dispatched_at: staleTime,
      finished_at: null,
      error: null,
    });
    Object.assign(lock, { is_busy: true, current_queue_id: 1, locked_at: staleTime });

    queue.push({
      id: 2,
      job_id: "waiting-job",
      workflow_file: "job-research.yml",
      inputs: {},
      status: "pending",
      created_at: new Date().toISOString(),
      dispatched_at: null,
      finished_at: null,
      error: null,
    });

    const dispatched: string[] = [];
    await tryDispatchNext({ supabaseClient: db, dispatchToGithub: async (i) => void dispatched.push(i.inputs.job_id) });

    assert(queue.find((r) => r.id === 1)!.status === "failed", "오래된 락이 붙잡고 있던 행은 failed로 정리돼야 한다");
    assert(dispatched.includes("waiting-job"), "락 회수 후 대기 중이던 다음 항목이 디스패치돼야 한다");
    console.log("✅ 30분 넘은 stale 락 -> 자동 회수 + 대기 중이던 다음 항목 진행");
  }

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
