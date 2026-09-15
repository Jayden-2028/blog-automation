// dispatchGithubWorkflow의 concurrency 취소 회피 로직(waitForFreeConcurrencySlot) 회귀 테스트.
// 실제 GitHub API는 호출하지 않는다 - fetchImpl을 주입해 응답을 흉내낸다.
import { dispatchGithubWorkflow } from "./dispatchWorkflow.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function main(): Promise<void> {
  // 1) concurrencyGroupWorkflows를 안 주면 대기 없이 바로 디스패치한다(기존 동작 그대로).
  {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;

    await dispatchGithubWorkflow({
      workflowFile: "job-research.yml",
      inputs: { job_id: "a" },
      token: "t",
      repository: "owner/repo",
      fetchImpl,
    });

    assert(calls.length === 1, "그룹 미지정 시 조회 없이 dispatch 호출 1회만 있어야 한다");
    assert(calls[0].url.includes("/dispatches"), "dispatch URL이 호출돼야 한다");
  }

  // 2) 그룹에 대기 중인 실행이 없으면(0건) 즉시 디스패치한다 - 조회 지연 없음.
  {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push({ url });
      if (url.includes("/actions/runs?")) {
        return jsonResponse({ workflow_runs: [] });
      }
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    await dispatchGithubWorkflow({
      workflowFile: "job-write.yml",
      inputs: { job_id: "b" },
      token: "t",
      repository: "owner/repo",
      concurrencyGroupWorkflows: ["job-research.yml", "job-write.yml", "job-revise.yml"],
      avoidEvictionPollIntervalMs: 20,
      fetchImpl,
    });

    assert(Date.now() - startedAt < 200, "대기 중인 실행이 없으면 지연 없이 바로 디스패치해야 한다");
    assert(calls.some((c) => c.url.includes("/dispatches")), "결국 dispatch 호출이 있어야 한다");
  }

  // 3) 그룹에 다른 워크플로우가 대기 중이면(예: job-research.yml이 queued) 재확인하며 기다리다가,
  //    빈 것으로 바뀌면 그때 디스패치한다.
  {
    let queuedChecks = 0;
    const calls: Call[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push({ url });
      if (url.includes("/actions/runs?")) {
        queuedChecks += 1;
        // 처음 두 번은 대기 중, 세 번째부터는 비었다고 응답.
        const stillQueued = queuedChecks <= 2;
        return jsonResponse({
          workflow_runs: stillQueued ? [{ path: ".github/workflows/job-research.yml" }] : [],
        });
      }
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;

    await dispatchGithubWorkflow({
      workflowFile: "job-write.yml",
      inputs: { job_id: "c" },
      token: "t",
      repository: "owner/repo",
      concurrencyGroupWorkflows: ["job-research.yml", "job-write.yml", "job-revise.yml"],
      avoidEvictionPollIntervalMs: 5,
      fetchImpl,
    });

    assert(queuedChecks === 3, `대기 3번 확인 후(비워짐 확인) 디스패치해야 한다 (실제: ${queuedChecks}회)`);
    assert(calls[calls.length - 1].url.includes("/dispatches"), "마지막 호출은 dispatch여야 한다");
  }

  // 4) 그룹과 무관한 워크플로우가 대기 중이면(path가 목록에 없음) 기다리지 않고 바로 디스패치한다.
  {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push({ url });
      if (url.includes("/actions/runs?")) {
        return jsonResponse({ workflow_runs: [{ path: ".github/workflows/job-publish-prepare.yml" }] });
      }
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    await dispatchGithubWorkflow({
      workflowFile: "job-write.yml",
      inputs: { job_id: "d" },
      token: "t",
      repository: "owner/repo",
      concurrencyGroupWorkflows: ["job-research.yml", "job-write.yml", "job-revise.yml"],
      avoidEvictionPollIntervalMs: 20,
      fetchImpl,
    });

    assert(Date.now() - startedAt < 200, "그룹 밖 워크플로우는 무시하고 바로 디스패치해야 한다");
  }

  // 5) maxWaitMs를 넘기면 포기하고 그냥 디스패치한다(영원히 대기하지 않는다).
  {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/actions/runs?")) {
        return jsonResponse({ workflow_runs: [{ path: ".github/workflows/job-research.yml" }] });
      }
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    let dispatched = false;
    await dispatchGithubWorkflow({
      workflowFile: "job-write.yml",
      inputs: { job_id: "e" },
      token: "t",
      repository: "owner/repo",
      concurrencyGroupWorkflows: ["job-research.yml", "job-write.yml", "job-revise.yml"],
      avoidEvictionMaxWaitMs: 30,
      avoidEvictionPollIntervalMs: 15,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        const response = await fetchImpl(...args);
        if (args[0].toString().includes("/dispatches")) dispatched = true;
        return response;
      }) as unknown as typeof fetch,
    });

    assert(dispatched, "maxWaitMs를 넘기면 대기 중이어도 결국 디스패치해야 한다");
    assert(Date.now() - startedAt < 500, "너무 오래 기다리면 안 된다(maxWaitMs 상한 적용)");
  }

  // 6) 대기 조회(status=queued API) 자체가 실패해도(non-ok) 디스패치를 막지 않는다.
  {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/actions/runs?")) {
        return jsonResponse({}, false, 500);
      }
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;

    let threw = false;
    try {
      await dispatchGithubWorkflow({
        workflowFile: "job-write.yml",
        inputs: { job_id: "f" },
        token: "t",
        repository: "owner/repo",
        concurrencyGroupWorkflows: ["job-research.yml", "job-write.yml", "job-revise.yml"],
        fetchImpl,
      });
    } catch {
      threw = true;
    }
    assert(!threw, "대기 조회 실패는 디스패치 자체를 막으면 안 된다");
  }

  console.log("✅ 그룹 미지정 -> 조회 없이 즉시 디스패치");
  console.log("✅ 대기 0건 -> 지연 없이 디스패치");
  console.log("✅ 대기 중 -> 재확인하며 기다렸다가 비면 디스패치");
  console.log("✅ 그룹 밖 워크플로우 대기 -> 무시하고 즉시 디스패치");
  console.log("✅ maxWaitMs 초과 -> 대기 포기하고 디스패치");
  console.log("✅ 대기 조회 실패 -> 디스패치 차단 안 함");
  console.log("\n✅ dispatchWorkflow 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
