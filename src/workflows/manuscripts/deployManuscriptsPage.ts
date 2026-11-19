// manuscripts/ 디렉터리를 Cloudflare Pages로 배포한다(2026-09-06). 헤드리스 claude -p에는
// Artifact 게시 도구가 없어(실측 확인) 로컬 파이프라인이 직접 배포하는 방식을 택했다.
//
// 이 프로젝트에서 외부 CLI를 쉘아웃하는 첫 사례다(scripts/statusDashboard.ts의 execFileSync(git)
// 와 같은 방식). 실행 함수를 주입 가능하게 만들어 테스트에서 실제 wrangler 프로세스를 띄우지 않는다.

import { execFile } from "node:child_process";

import { CLOUDFLARE_PAGES_CONFIG } from "../../config/manuscriptsPageTargets.js";
import type { CloudflarePagesConfig } from "../../config/manuscriptsPageTargets.js";
import { PIPELINE_ROOT, MANUSCRIPTS_DIR } from "../../config/pipelinePaths.js";

// 네이버 육아 뷰어(public/naver-parenting.html)를 이 Pages 프로젝트에 얹던 단계는 2026-11-19에 걷어냈다.
// 원본 폴더(blog-manuscripts/naver-parenting)를 사용자가 지웠고, 배포는 매번 MANUSCRIPTS_DIR 전체 스냅샷이라
// 복사 단계를 빼면 다음 배포에서 그 페이지도 사라진다.

export type DeployManuscriptsPageResult =
  | { status: "skipped"; reason: string }
  | { status: "success"; url: string }
  | { status: "failed"; error: string };

export type RunWrangler = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;

function defaultRunWrangler(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("npx", args, { cwd: PIPELINE_ROOT, env, timeout: 5 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

export type DeployManuscriptsPageOptions = {
  runWrangler?: RunWrangler;
  /** 테스트 주입용. 기본은 CLOUDFLARE_PAGES_CONFIG(환경변수 기반). */
  config?: CloudflarePagesConfig;
};

export async function deployManuscriptsPage(
  options: DeployManuscriptsPageOptions = {}
): Promise<DeployManuscriptsPageResult> {
  const config = options.config ?? CLOUDFLARE_PAGES_CONFIG;
  if (!config.enabled) {
    return { status: "skipped", reason: "Cloudflare Pages 환경변수 미설정(CLOUDFLARE_PAGES_PROJECT_NAME/ACCOUNT_ID/API_TOKEN)" };
  }
  const runWrangler = options.runWrangler ?? defaultRunWrangler;

  try {
    await runWrangler(
      ["--yes", "wrangler@4", "pages", "deploy", MANUSCRIPTS_DIR, "--project-name", config.projectName!, "--branch", "main", "--commit-dirty=true"],
      { ...process.env, CLOUDFLARE_API_TOKEN: config.apiToken, CLOUDFLARE_ACCOUNT_ID: config.accountId }
    );
    return { status: "success", url: `https://${config.projectName}.pages.dev` };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
