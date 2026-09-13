// GitHub Actions workflow_dispatch API 호출 - Phase 3(텔레그램 웹훅 릴레이)에서 무거운 작업
// (job:research/job:write)을 "이 러너 안에서 detached로 띄우기"가 아니라 "완전히 새 워크플로우
// 실행으로 발화"하는 데 쓴다. GH Actions 러너는 job이 끝나면 통째로 내려가 detached 자식이
// 못 살아남는다(로컬 launchd와 결정적으로 다른 점) - 그래서 별도 워크플로우 실행을 API로 새로
// 만드는 방식을 쓴다.

const GITHUB_API_BASE_URL = "https://api.github.com";

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
};

export async function dispatchGithubWorkflow(input: DispatchWorkflowInput): Promise<void> {
  const token = input.token ?? process.env.GITHUB_TOKEN;
  const repository = input.repository ?? process.env.GITHUB_REPOSITORY;

  if (!token) throw new Error("GITHUB_TOKEN이 없어 workflow_dispatch를 호출할 수 없습니다.");
  if (!repository) throw new Error("GITHUB_REPOSITORY가 없어 대상 저장소를 알 수 없습니다.");

  const url = `${GITHUB_API_BASE_URL}/repos/${repository}/actions/workflows/${input.workflowFile}/dispatches`;
  const response = await fetch(url, {
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
