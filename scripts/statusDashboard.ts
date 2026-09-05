// 브랜치·배포 현황을 한 번에 보여준다(status:all). 읽기 전용 git 명령만 쓴다.
//
// 사용법:
//   npm run status:all              origin fetch 후 현황 출력 + logs/status.html 생성
//   npm run status:all -- --no-fetch  네트워크 없이 로컬이 아는 정보만으로
//
// 운영 worktree 경로는 BLOG_PROD_PATH 환경변수로 바꿀 수 있다(기본 ~/blog-automation-prod).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { buildStatusReportHtml, summarize } from "../src/workflows/reports/buildStatusReportHtml.js";
import type { BranchStatus, ProdStatus } from "../src/workflows/reports/buildStatusReportHtml.js";

const PROD_PATH = process.env.BLOG_PROD_PATH || resolve(homedir(), "blog-automation-prod");
const OUTPUT_PATH = resolve("logs/status.html");

/** git 실행 헬퍼. 실패해도 예외 대신 null을 돌려 현황 출력 자체가 죽지 않게 한다. */
function git(args: string[], cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function collectBranches(): BranchStatus[] {
  const raw = git(["branch", "-r", "--format=%(refname:short)"]) ?? "";
  const names = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("HEAD") && line !== "origin/main");

  const branches: BranchStatus[] = [];
  for (const remoteName of names) {
    // "<behind>\t<ahead>" - main에 있는데 이 브랜치엔 없는 수 / 그 반대
    const counts = git(["rev-list", "--left-right", "--count", `origin/main...${remoteName}`]);
    const [behind, ahead] = (counts ?? "0\t0").split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);

    const merged = git(["merge-base", "--is-ancestor", remoteName, "origin/main"]) !== null;
    const lastCommitDate = git(["log", "-1", "--format=%ad", "--date=short", remoteName]) ?? "";
    const lastCommitSubject = git(["log", "-1", "--format=%s", remoteName]) ?? "";

    const uniqueCommits = merged
      ? []
      : (git(["log", "--oneline", `origin/main..${remoteName}`]) ?? "").split("\n").filter(Boolean);

    branches.push({
      name: remoteName.replace(/^origin\//, ""),
      ahead,
      behind,
      merged,
      lastCommitDate,
      lastCommitSubject,
      uniqueCommits,
    });
  }
  return branches;
}

function collectProd(): ProdStatus {
  if (!existsSync(PROD_PATH)) {
    return { path: PROD_PATH, exists: false, branch: null, head: null, behindMain: null, dirty: false };
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], PROD_PATH);
  const head = git(["rev-parse", "--short", "HEAD"], PROD_PATH);
  // 운영 worktree가 origin/main을 얼마나 못 따라왔는지. 개발 레포에서 방금 fetch한 origin/main과 비교한다.
  const counts = git(["rev-list", "--count", "HEAD..origin/main"], PROD_PATH);
  const behindMain = counts === null ? null : Number.parseInt(counts, 10) || 0;
  const dirty = (git(["status", "--porcelain"], PROD_PATH) ?? "") !== "";

  return { path: PROD_PATH, exists: true, branch, head, behindMain, dirty };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--no-fetch")) {
    console.log("▶ origin fetch 중...");
    git(["fetch", "origin", "--prune"]);
    git(["fetch", "origin", "--prune"], existsSync(PROD_PATH) ? PROD_PATH : process.cwd());
  }

  const branches = collectBranches();
  const prod = collectProd();
  const devBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "?";
  const devDirty = (git(["status", "--porcelain"]) ?? "") !== "";
  const mainHead = git(["log", "-1", "--format=%h %s", "origin/main"]) ?? "?";

  const input = { branches, prod, devBranch, devDirty, mainHead };

  // 터미널 요약 - 파일을 안 열어도 바로 판단할 수 있어야 한다.
  console.log("");
  for (const line of summarize(input)) console.log(`  ${line}`);

  const unmerged = branches.filter((b) => !b.merged);
  if (unmerged.length > 0) {
    console.log("\n미병합 브랜치:");
    for (const branch of unmerged) {
      console.log(`  ${branch.name} (+${branch.ahead} / -${branch.behind}, ${branch.lastCommitDate})`);
      for (const commit of branch.uniqueCommits) console.log(`      ${commit}`);
    }
  }

  console.log(`\nmain 최신: ${mainHead}`);
  console.log(
    `운영(prod): ${prod.exists ? `${prod.branch} @ ${prod.head} (main보다 ${prod.behindMain}커밋 뒤)` : `없음 - ${prod.path}`}`
  );

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, buildStatusReportHtml(input), "utf8");
  console.log(`\n✅ ${OUTPUT_PATH}`);
  console.log(`   열기: open ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("❌ 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
