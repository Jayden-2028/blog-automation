// manuscripts/ 디렉터리를 Cloudflare Pages로 배포한다(2026-09-06). 헤드리스 claude -p에는
// Artifact 게시 도구가 없어(실측 확인) 로컬 파이프라인이 직접 배포하는 방식을 택했다.
//
// 이 프로젝트에서 외부 CLI를 쉘아웃하는 첫 사례다(scripts/statusDashboard.ts의 execFileSync(git)
// 와 같은 방식). 실행 함수를 주입 가능하게 만들어 테스트에서 실제 wrangler 프로세스를 띄우지 않는다.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { CLOUDFLARE_PAGES_CONFIG } from "../../config/manuscriptsPageTargets.js";
import type { CloudflarePagesConfig } from "../../config/manuscriptsPageTargets.js";
import { PIPELINE_ROOT, MANUSCRIPTS_DIR } from "../../config/pipelinePaths.js";

// 네이버 육아 뷰어(별도 폴더 blog-manuscripts/naver-parenting/viewer.html)를 같은 Pages
// 프로젝트에 얹는다(2026-09-19). 왜 이 프로젝트에 합치는가: 새 Pages 프로젝트를 파면 그 호스트는
// 기본이 공개라 Access 애플리케이션을 하나 더 만들기 전까지 초고가 노출된다. 여기 얹으면
// 2026-09-14에 건 owner-email 게이트를 그대로 상속한다.
//
// 왜 repo 안에 파일을 두는가: 배포는 GitHub Actions가 저장소를 새로 checkout해서 돌리므로
// manuscripts/(gitignored)에 로컬로 넣어둔 파일은 다음 배포에서 사라진다. repo에 커밋된
// public/ 파일을 배포 직전에 복사해야 매 배포마다 살아남는다.
const EXTRA_STATIC_PAGES: Array<{ from: string; to: string }> = [
  { from: "public/naver-parenting.html", to: "naver-parenting.html" },
];

/** 배포 디렉터리에 repo 안의 정적 파일을 얹는다. 없으면 조용히 건너뛴다(배포는 계속된다). */
function stageExtraStaticPages(): void {
  for (const page of EXTRA_STATIC_PAGES) {
    try {
      const src = resolve(PIPELINE_ROOT, page.from);
      if (!existsSync(src)) continue;
      const dest = resolve(PIPELINE_ROOT, MANUSCRIPTS_DIR, page.to);
      mkdirSync(resolve(PIPELINE_ROOT, MANUSCRIPTS_DIR), { recursive: true });
      copyFileSync(src, dest);
    } catch {
      // 부가 페이지 복사 실패가 원고 페이지 배포를 막으면 안 된다.
    }
  }
}

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

  stageExtraStaticPages();

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
