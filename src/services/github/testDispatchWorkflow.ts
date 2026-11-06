// dispatchGithubWorkflow의 concurrency 취소 회피 로직(waitForFreeConcurrencySlot) 회귀 테스트.
// 실제 GitHub API는 호출하지 않는다 - fetchImpl을 주입해 응답을 흉내낸다.
import { DISPATCH_RETRY_DELAYS_MS, dispatchGithubWorkflow } from "./dispatchWorkflow.js";

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

// 재시도 로그(console.error/log)가 테스트 출력을 어지럽히지 않게 조용히 돌린다.
async function quietLog<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
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

  // 7) 5xx가 세 번 나도 네 번째에 성공하면 던지지 않는다. 대기는 2·6·12초(Worker와 같은 간격)이고,
  //    테스트는 sleep을 주입해 실제로 기다리지 않는다.
  {
    const statuses = [500, 502, 503, 204];
    const sleeps: number[] = [];
    let dispatchCalls = 0;
    const fetchImpl = (async () => {
      const status = statuses[dispatchCalls++];
      return jsonResponse({ message: "boom" }, status < 400, status);
    }) as unknown as typeof fetch;

    await quietLog(() =>
      dispatchGithubWorkflow({
        workflowFile: "job-research.yml",
        inputs: { job_id: "g" },
        token: "t",
        repository: "owner/repo",
        fetchImpl,
        sleep: async (ms) => void sleeps.push(ms),
      })
    );

    assert(dispatchCalls === 4, `500 세 번 뒤 네 번째에 성공해야 한다 (실제 호출: ${dispatchCalls}회)`);
    assert(sleeps.join(",") === "2000,6000,12000", `대기는 2·6·12초여야 한다 (실제: ${sleeps.join(",")})`);
    assert(DISPATCH_RETRY_DELAYS_MS.join(",") === "2000,6000,12000", "재시도 간격은 Worker와 같아야 한다");
  }

  // 8) 4xx는 토큰·권한·입력 문제라 재시도 없이 즉시 던진다(사유가 메시지에 남는다).
  {
    for (const status of [401, 403, 404, 422]) {
      let dispatchCalls = 0;
      const sleeps: number[] = [];
      const fetchImpl = (async () => {
        dispatchCalls += 1;
        return jsonResponse({ message: "nope" }, false, status);
      }) as unknown as typeof fetch;

      let message = "";
      try {
        await dispatchGithubWorkflow({
          workflowFile: "job-write.yml",
          inputs: { job_id: "h" },
          token: "t",
          repository: "owner/repo",
          fetchImpl,
          sleep: async (ms) => void sleeps.push(ms),
        });
      } catch (error) {
        message = (error as Error).message;
      }
      assert(dispatchCalls === 1, `${status}은 재시도하면 안 된다 (실제 호출: ${dispatchCalls}회)`);
      assert(sleeps.length === 0, `${status}은 기다리면 안 된다`);
      assert(message.includes(`${status}`) && message.includes("job-write.yml"), `${status} 사유가 메시지에 남아야 한다: ${message}`);
    }
  }

  // 9) 408·429는 재시도 대상이다.
  {
    for (const status of [408, 429]) {
      let dispatchCalls = 0;
      const fetchImpl = (async () => {
        dispatchCalls += 1;
        return dispatchCalls === 1 ? jsonResponse({}, false, status) : jsonResponse({}, true, 204);
      }) as unknown as typeof fetch;
      await quietLog(() =>
        dispatchGithubWorkflow({
          workflowFile: "job-write.yml",
          inputs: { job_id: "i" },
          token: "t",
          repository: "owner/repo",
          fetchImpl,
          sleep: async () => {},
        })
      );
      assert(dispatchCalls === 2, `${status}은 재시도해야 한다 (실제 호출: ${dispatchCalls}회)`);
    }
  }

  // 10) 네트워크 오류(fetch가 throw)도 재시도하고, 계속 실패하면 4회에서 마지막 오류를 던진다.
  {
    let dispatchCalls = 0;
    const fetchImpl = (async () => {
      dispatchCalls += 1;
      if (dispatchCalls < 3) throw new TypeError("fetch failed");
      return jsonResponse({}, true, 204);
    }) as unknown as typeof fetch;
    await quietLog(() =>
      dispatchGithubWorkflow({
        workflowFile: "job-research.yml",
        inputs: { job_id: "j" },
        token: "t",
        repository: "owner/repo",
        fetchImpl,
        sleep: async () => {},
      })
    );
    assert(dispatchCalls === 3, `네트워크 오류 두 번 뒤 성공해야 한다 (실제 호출: ${dispatchCalls}회)`);

    let alwaysFailCalls = 0;
    let message = "";
    try {
      await quietLog(() =>
        dispatchGithubWorkflow({
          workflowFile: "job-research.yml",
          inputs: { job_id: "k" },
          token: "t",
          repository: "owner/repo",
          fetchImpl: (async () => {
            alwaysFailCalls += 1;
            throw new TypeError("fetch failed");
          }) as unknown as typeof fetch,
          sleep: async () => {},
        })
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assert(alwaysFailCalls === 4, `계속 실패하면 최대 4회에서 멈춰야 한다 (실제: ${alwaysFailCalls}회)`);
    assert(message === "fetch failed", `마지막 네트워크 오류를 그대로 던져야 한다: ${message}`);
  }

  // 11) 5xx가 끝까지 계속되면 4회 시도 뒤 마지막 응답의 상태·본문을 담아 던진다(큐 행 error에 그대로 남는다).
  {
    let dispatchCalls = 0;
    let message = "";
    try {
      await quietLog(() =>
        dispatchGithubWorkflow({
          workflowFile: "job-research.yml",
          inputs: { job_id: "l" },
          token: "t",
          repository: "owner/repo",
          fetchImpl: (async () => {
            dispatchCalls += 1;
            return jsonResponse({ message: "Server Error" }, false, 500);
          }) as unknown as typeof fetch,
          sleep: async () => {},
        })
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assert(dispatchCalls === 4, `500이 계속되면 4회 시도해야 한다 (실제: ${dispatchCalls}회)`);
    assert(message.includes("500") && message.includes("job-research.yml"), `최종 오류에 상태·워크플로우가 있어야 한다: ${message}`);
  }

  console.log("✅ 그룹 미지정 -> 조회 없이 즉시 디스패치");
  console.log("✅ 대기 0건 -> 지연 없이 디스패치");
  console.log("✅ 대기 중 -> 재확인하며 기다렸다가 비면 디스패치");
  console.log("✅ 그룹 밖 워크플로우 대기 -> 무시하고 즉시 디스패치");
  console.log("✅ maxWaitMs 초과 -> 대기 포기하고 디스패치");
  console.log("✅ 대기 조회 실패 -> 디스패치 차단 안 함");
  console.log("✅ 5xx 세 번 뒤 성공 -> 2·6·12초 대기로 재시도");
  console.log("✅ 4xx -> 재시도 없이 즉시 실패");
  console.log("✅ 408·429 -> 재시도");
  console.log("✅ 네트워크 오류 -> 재시도, 계속되면 4회 뒤 마지막 오류");
  console.log("✅ 5xx 지속 -> 4회 뒤 상태·본문을 담아 실패");
  console.log("\n✅ dispatchWorkflow 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
