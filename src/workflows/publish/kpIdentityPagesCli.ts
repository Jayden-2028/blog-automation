// Korea Plain 고정 페이지 3종(About·Editorial Policy·Contact)에 로컬 정체성 카피를 반영한다(2026-10-30, 일회성).
// 기본은 dry-run - 아무것도 쓰지 않고 페이지마다 바뀔 줄을 출력한다.
//
//   npm run kp:identity-pages                 # dry-run(세 페이지 전부)
//   npm run kp:identity-pages -- --apply      # 실제 적용(pages.patch)
//   옵션: --only=about|editorial|contact (또는 경로 일부)
//
// 근거: branding-2026-10/kp-native-identity-2026-10.md §A-3·§A-4·§A-6(사용자 2026-10-30 승인).
// 바꾸는 것은 **본문만**이다 - 제목·슬러그·공개 상태는 그대로 보낸다(patchPage는 제목을 함께 보내므로 읽은 제목을 그대로 되돌려준다).
// 적용 뒤 getPage로 다시 읽어 반영을 확인한다. DB는 읽지도 쓰지도 않는다.

import { appendFileSync } from "node:fs";
import { KSCENE_BLOGGER_BLOG_ID } from "../../config/publishTargets.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import { KP_IDENTITY_PAGES, diffLines, pageLines } from "./kpIdentityPages.js";

type Args = { apply: boolean; only: string | null };

function parseArgs(argv: string[]): Args {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=").trim() || null;
  return { apply: argv.includes("--apply"), only: value("only") };
}

const ALIASES: Record<string, string> = { about: "about-korea-manual", editorial: "editorial-policy", contact: "contact" };

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!KSCENE_BLOGGER_BLOG_ID) throw new Error("KSCENE_BLOGGER_BLOG_ID가 없습니다");
  const client = new BloggerClient({ blogId: KSCENE_BLOGGER_BLOG_ID });

  const listed = await client.listPages({ fetchBodies: true });
  if (!listed.ok) throw new Error(listed.error);

  const only = args.only ? (ALIASES[args.only.toLowerCase()] ?? args.only) : null;
  const report: string[] = [`모드: ${args.apply ? "apply" : "dry-run"}${only ? ` (only=${only})` : ""}`, ""];
  const rows: string[] = ["| 페이지 | 경로 | 변경 | 줄 +/- | 상태 |", "|---|---|---|---|---|"];
  const failures: string[] = [];

  for (const target of KP_IDENTITY_PAGES) {
    if (only && !target.path.includes(only)) continue;
    const page = listed.pages.find((candidate) => pathOf(candidate.url) === target.path);
    if (!page || page.content === undefined) {
      failures.push(`${target.label}: ${target.path} 페이지를 찾지 못함`);
      rows.push(`| ${target.label} | ${target.path} | - | - | fail:not-found |`);
      continue;
    }
    const edit = target.apply(page.content);
    const diff = diffLines(pageLines(page.content), pageLines(edit.html));
    const added = diff.filter((line) => line.startsWith("+ ")).length;
    const removed = diff.filter((line) => line.startsWith("- ")).length;

    if (!edit.changed) {
      rows.push(`| ${target.label} | ${target.path} | - | 0/0 | skip:${edit.note} |`);
      continue;
    }

    report.push(`### ${target.label} (${target.path}) - ${edit.note}`, "```diff", ...diff.filter((line) => !line.startsWith("  ")), "```", "");

    if (!args.apply) {
      rows.push(`| ${target.label} | ${target.path} | Y | +${added}/-${removed} | dry-run |`);
      continue;
    }

    const patched = await client.patchPage(page.id, page.title, edit.html);
    if (!patched.ok) {
      failures.push(`${target.label}: 갱신 실패 - ${patched.error}`);
      rows.push(`| ${target.label} | ${target.path} | Y | +${added}/-${removed} | fail:patch |`);
      continue;
    }
    const stored = await client.getPage(page.id);
    const storedLines = stored.ok ? pageLines(stored.content) : [];
    const wantLines = pageLines(edit.html);
    const kept = stored.ok && stored.title === page.title && wantLines.every((line) => storedLines.includes(line));
    rows.push(`| ${target.label} | ${target.path} | Y | +${added}/-${removed} | ${kept ? "ok" : "warn:stored-differs"} |`);
    if (!kept) failures.push(`${target.label}: 저장된 본문이 기대와 다름(제목 "${stored.ok ? stored.title : "?"}")`);
  }

  const out = [...rows, "", ...report, ...(failures.length > 0 ? ["실패/주의:", ...failures.map((failure) => `- ${failure}`)] : [])].join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Korea Plain 정체성 페이지\n\n${out}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
