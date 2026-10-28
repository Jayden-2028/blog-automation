// 보고서를 파일로 쓰고 PR을 만든다(Actions 안에서 GITHUB_TOKEN으로). main 직접 푸시는 하지 않는다.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const REPORT_DIR = "docs/style-learning";

export async function writeReportFile(root: string, label: string, markdown: string): Promise<string> {
  const rel = `${REPORT_DIR}/${label}.md`;
  await mkdir(join(root, REPORT_DIR), { recursive: true });
  await writeFile(join(root, rel), markdown, "utf8");
  return rel;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** 보고서 파일만 새 브랜치에 커밋·푸시하고 PR URL을 돌려준다. 같은 이름 브랜치가 원격에 있으면 접미사를 붙인다. */
export async function openReportPr(rel: string, label: string, body: string): Promise<string> {
  let branch = `style-learn/${label}`;
  if ((await git(["ls-remote", "--heads", "origin", branch])).length > 0) branch = `${branch}-${Date.now().toString(36)}`;
  if (process.env.GITHUB_ACTIONS) {
    await git(["config", "user.name", "github-actions[bot]"]);
    await git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  }
  await git(["checkout", "-b", branch]);
  await git(["add", "--", rel]);
  await git(["commit", "-m", `docs(style-learning): ${label} 네이버 문체 학습 보고`, "--", rel]);
  await git(["push", "-u", "origin", branch]);
  const { stdout } = await run(
    "gh",
    ["pr", "create", "--base", "main", "--head", branch, "--title", `style-learn: ${label} 네이버 문체 학습 보고`, "--body", body],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout.trim().split("\n").pop() ?? "";
}
