// 계정 레벨 스킬(entertainment/parenting/trend-blog-writer)과 prompts/writing/style/*.md
// 파생본 사이의 드리프트를 감지한다. 2026-09-03 원고 퀄리티 점검에서 발견한 문제(파생본이
// 원본을 그대로 베낀 게 아니라 일부러 고친 버전이라, 자동 복사는 오늘 고친 내용을 원본의 옛
// 표현으로 도로 덮어쓸 수 있음) 때문에 이 스크립트는 **자동으로 파일을 덮어쓰지 않는다.**
//
// 하는 일: 계정 스킬 원문을 찾아, 지난번 동기화 시점에 저장해 둔 스냅샷과 비교해 diff를 보여준다.
// 다른 게 없으면 조용히 끝난다. 다르면 diff를 보여주고, `--apply`를 주면 스냅샷만 갱신한다(파생본
// 파일은 그대로 둔다 - 실제 반영은 diff를 읽고 판단해서 prompts/writing/style/<카테고리>.md를
// 직접 고치는 사람/에이전트의 몫이다).
//
// 실행: npm run sync:writer-style           (드리프트 확인만)
//       npm run sync:writer-style -- --apply (확인 후 스냅샷 갱신)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

type Category = "parenting" | "entertainment" | "trend";

const CATEGORIES: Category[] = ["parenting", "entertainment", "trend"];

// 2026-09-06: 실제 위치를 찾아 고쳤다 - 예전 경로(~/.claude/skills/synced)는 이 macOS 버전에
// 존재하지 않아 늘 "못 찾음"만 출력했다(748f514 실측 결함). 실제로는 Claude 데스크톱 앱의
// 로컬 에이전트 세션 저장소 아래, 세션 UUID 두 겹을 거쳐 있다:
//   ~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/<uuid1>/<uuid2>/skills/<category>-blog-writer/SKILL.md
const SKILLS_ROOT = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "local-agent-mode-sessions",
  "skills-plugin"
);
const SNAPSHOT_DIR = join("prompts", "writing", "style", ".snapshots");
const STYLE_FILE = (c: Category) => join("prompts", "writing", "style", `${c}.md`);
const SNAPSHOT_FILE = (c: Category) => join(SNAPSHOT_DIR, `${c}.skill.md`);
const SKILL_DIR_NAME = (c: Category) => `${c}-blog-writer`;

/** SKILLS_ROOT/<uuid1>/<uuid2>/skills/<category>-blog-writer/SKILL.md 를 찾는다(세션 UUID 두 겹). */
function findSkillFile(category: Category): string | null {
  if (!existsSync(SKILLS_ROOT)) return null;
  for (const outer of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!outer.isDirectory()) continue;
    const outerDir = join(SKILLS_ROOT, outer.name);
    for (const inner of readdirSync(outerDir, { withFileTypes: true })) {
      if (!inner.isDirectory()) continue;
      const candidate = join(outerDir, inner.name, "skills", SKILL_DIR_NAME(category), "SKILL.md");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** diff -u는 두 파일 인자가 필요해서 임시 파일로 비교한다. */
function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string {
  const tmpOld = join(SNAPSHOT_DIR, `.tmp-old-${Date.now()}.md`);
  const tmpNew = join(SNAPSHOT_DIR, `.tmp-new-${Date.now()}.md`);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(tmpOld, oldText);
  writeFileSync(tmpNew, newText);
  try {
    execFileSync("diff", ["-u", "--label", oldLabel, "--label", newLabel, tmpOld, tmpNew]);
    return ""; // 동일하면 diff는 exit 0 + 빈 출력
  } catch (error) {
    const e = error as { stdout?: Buffer };
    return e.stdout ? e.stdout.toString() : "";
  } finally {
    try {
      execFileSync("rm", ["-f", tmpOld, tmpNew]);
    } catch {
      /* 정리 실패는 무시 */
    }
  }
}

function main(): void {
  const apply = process.argv.includes("--apply");
  mkdirSync(SNAPSHOT_DIR, { recursive: true });

  let anyDrift = false;
  let anyMissing = false;

  for (const category of CATEGORIES) {
    const skillPath = findSkillFile(category);
    if (!skillPath) {
      console.log(`⚠️  [${category}] 이 머신에서 계정 스킬을 못 찾음(${SKILLS_ROOT}/*/${SKILL_DIR_NAME(category)}/SKILL.md 없음) - 건너뜀`);
      anyMissing = true;
      continue;
    }

    const current = readFileSync(skillPath, "utf-8");
    const snapshotPath = SNAPSHOT_FILE(category);
    const previous = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf-8") : null;

    if (previous === null) {
      console.log(`🆕 [${category}] 스냅샷 없음(첫 실행). 지금 상태를 기준으로 저장${apply ? "함" : "하려면 --apply"}.`);
      if (apply) writeFileSync(snapshotPath, current);
      continue;
    }

    if (previous === current) {
      console.log(`✅ [${category}] 지난 동기화 이후 계정 스킬 변경 없음.`);
      continue;
    }

    anyDrift = true;
    console.log(`\n🔶 [${category}] 계정 스킬이 지난 동기화 이후 바뀜: ${skillPath}`);
    console.log(`   파생본(${STYLE_FILE(category)})에 반영할지 diff를 보고 직접 판단할 것.`);
    console.log(unifiedDiff(previous, current, "지난 동기화 시점", "지금 계정 스킬"));

    if (apply) {
      writeFileSync(snapshotPath, current);
      console.log(`   → 스냅샷 갱신함(${snapshotPath}). 파생본 파일 자체는 안 건드림 - 위 diff를 보고 직접 고칠 것.`);
    }
  }

  if (anyMissing) {
    console.log(
      "\nℹ️ 이 저장소를 원고 자동화 운영 머신(계정 스킬이 설치된 그 컴퓨터)에서 실행해야 드리프트를 감지할 수 있다."
    );
  }
  if (anyDrift && !apply) {
    console.log("\n반영을 마쳤으면 `npm run sync:writer-style -- --apply`로 스냅샷을 갱신할 것(다음부터 같은 diff가 반복 표시되지 않는다).");
  }
}

main();
