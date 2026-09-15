// GitHub Actions workflow_dispatch API 호출 - Phase 3(텔레그램 웹훅 릴레이)에서 무거운 작업
// (job:research/job:write)을 "이 러너 안에서 detached로 띄우기"가 아니라 "완전히 새 워크플로우
// 실행으로 발화"하는 데 쓴다. GH Actions 러너는 job이 끝나면 통째로 내려가 detached 자식이
// 못 살아남는다(로컬 launchd와 결정적으로 다른 점) - 그래서 별도 워크플로우 실행을 API로 새로
// 만드는 방식을 쓴다.
//
// 2026-09-15 추가(실측 사고 - "강식당 돈까스"/"경복궁 구멍 뚫기" 두 원고가 조용히 유실됨):
// job-research.yml/job-write.yml/job-revise.yml은 GitHub Actions concurrency group
// "heavy-pipeline"을 공유해 직렬화한다(95803f1). 그런데 GitHub의 concurrency 큐는 "실행 중 1개 +
// 대기(queued) 1개"까지만 허용하고, 그 상태에서 새 workflow_dispatch가 또 오면 대기 중이던 실행을
// 경고 없이 그냥 취소한다 - job:research/job:write 코드가 실행되기도 전에 GH Actions 자체에서
// 잘리므로, 그 코드 안의 실패 알림(try/catch → Telegram)도 동작할 기회가 없다. Go를 연달아
// 누르거나(각 텔레그램 클릭이 별도 telegram-update.yml 실행으로 순차 처리되며 그 안에서
// triggerResearch를 부름) 조사 완료가 자동으로 집필을 잇달아 발화할 때(triggerWriting) 이미
// 대기 중이던 다른 job을 밀어낼 수 있다.
//
// concurrencyGroupWorkflows를 넘기면 디스패치 직전에 그 그룹에 이미 대기 중인 실행이 있는지
// 확인하고, 있으면 짧게 재시도하며 기다린다 - GitHub 큐 자체의 "대기 1개" 한도에 안 걸리게
// 호출자 쪽에서 미리 비켜준다(heavyPipelineLock.ts의 로컬 파일 락과 같은 철학을, 클라우드에선
// GitHub Actions API 폴링으로 재구현). 대기가 길어져도 결국 포기하고 그냥 디스패치한다 - 영원히
// 안 보내는 것보다는 경합을 감수하는 게 낫다.

const GITHUB_API_BASE_URL = "https://api.github.com";

/** job-research.yml/job-write.yml/job-revise.yml이 공유하는 concurrency group 멤버 목록. */
export const HEAVY_PIPELINE_WORKFLOWS = ["job-research.yml", "job-write.yml", "job-revise.yml"];

export type DispatchWorkflowInput = {
  /** 워크플로우 파일명(.github/workflows/ 아래), 예: "job-research.yml". */
  workflowFile: string;
  /** 그 워크플로우의 workflow_dispatch inputs. */
  inputs: Record<string, string>;
  /** 기본 "main". */
  ref?: string;
  /** 기본 process.env.GITHUB_TOKEN. */
  token?: string;
  /** "owner/repo" 형식. 기본 process.env.GITHUB_REPOSITORY(GH Actions가 자동으로 채움). */
  repository?: string;
  /**
   * 이 워크플로우와 concurrency 그룹을 공유하는 워크플로우 파일명 목록(자기 자신 포함, 예:
   * ["job-research.yml","job-write.yml","job-revise.yml"]). 주어지면 디스패치 전에 그룹에 이미
   * 대기 중인 실행이 있는지 확인해 취소 유발을 피한다. 안 주면(기본) 기존과 동일하게 바로
   * 디스패치한다.
   */
  concurrencyGroupWorkflows?: string[];
  /** 대기 상한(ms). 기본 3분 - 넘기면 포기하고 그냥 디스패치한다. */
  avoidEvictionMaxWaitMs?: number;
  /** 재확인 간격(ms). 기본 10초. */
  avoidEvictionPollIntervalMs?: number;
  /** 테스트 주입용. 기본 전역 fetch. */
  fetchImpl?: typeof fetch;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** workflowFiles 중 하나라도 현재 "queued"(대기 또는 concurrency 대기) 상태인 실행이 있는지 센다. */
async function countQueuedRunsInGroup(
  workflowFiles: string[],
  repository: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const response = await fetchImpl(`${GITHUB_API_BASE_URL}/repos/${repository}/actions/runs?status=queued&per_page=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  // 조회 실패는 "확인 불가"로 취급해 0건으로 본다 - 이 조회 때문에 원래 디스패치 자체가 막히면
  // 안 된다(취소 유발 방지는 best-effort일 뿐, 필수 전제조건이 아니다).
  if (!response.ok) return 0;

  const body = (await response.json().catch(() => null)) as { workflow_runs?: Array<{ path?: string }> } | null;
  const runs = body?.workflow_runs ?? [];
  const wanted = new Set(workflowFiles.map((file) => `.github/workflows/${file}`));
  return runs.filter((run) => run.path && wanted.has(run.path)).length;
}

/** concurrencyGroupWorkflows가 주어졌으면, 그룹의 대기(queued) 슬롯이 빌 때까지 기다린다. */
async function waitForFreeConcurrencySlot(input: DispatchWorkflowInput, repository: string, token: string): Promise<void> {
  const groupWorkflows = input.concurrencyGroupWorkflows;
  if (!groupWorkflows || groupWorkflows.length === 0) return;

  const fetchImpl = input.fetchImpl ?? fetch;
  const maxWaitMs = input.avoidEvictionMaxWaitMs ?? 3 * 60 * 1000;
  const pollIntervalMs = input.avoidEvictionPollIntervalMs ?? 10_000;
  const startedAt = Date.now();

  let queuedCount = await countQueuedRunsInGroup(groupWorkflows, repository, token, fetchImpl);
  while (queuedCount > 0) {
    if (Date.now() - startedAt > maxWaitMs) {
      console.warn(
        `⚠️ [dispatch-workflow] ${maxWaitMs}ms 기다려도 ${input.workflowFile}의 concurrency 그룹이 안 비어 ` +
          `그냥 디스패치합니다(대기 중이던 다른 실행을 밀어낼 수 있음).`
      );
      return;
    }
    await sleep(pollIntervalMs);
    queuedCount = await countQueuedRunsInGroup(groupWorkflows, repository, token, fetchImpl);
  }
}

export async function dispatchGithubWorkflow(input: DispatchWorkflowInput): Promise<void> {
  const token = input.token ?? process.env.GITHUB_TOKEN;
  const repository = input.repository ?? process.env.GITHUB_REPOSITORY;
  const fetchImpl = input.fetchImpl ?? fetch;

  if (!token) throw new Error("GITHUB_TOKEN이 없어 workflow_dispatch를 호출할 수 없습니다.");
  if (!repository) throw new Error("GITHUB_REPOSITORY가 없어 대상 저장소를 알 수 없습니다.");

  await waitForFreeConcurrencySlot(input, repository, token);

  const url = `${GITHUB_API_BASE_URL}/repos/${repository}/actions/workflows/${input.workflowFile}/dispatches`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: input.ref ?? "main", inputs: input.inputs }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `GitHub workflow_dispatch 실패(${input.workflowFile}): ${response.status} ${response.statusText} - ${bodyText.slice(0, 300)}`
    );
  }
}
