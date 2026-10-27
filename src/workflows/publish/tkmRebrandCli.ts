// Korea Plain 리브랜딩 일괄 적용(2026-10-28). 기본은 dry-run - 아무것도 쓰지 않고 글·페이지마다 바뀔 내용을 출력한다.
//
//   npm run tkm:rebrand                                   # dry-run(글 + 고정 페이지 전부)
//   npm run tkm:rebrand -- --apply --limit=1              # 바꿀 게 있는 첫 1건만 실제 적용
//   npm run tkm:rebrand -- --apply --target=posts         # 글만 / --target=pages 고정 페이지만
//   옵션: --only=<postId|pageId|URL 일부>
//
// 운영 자격 증명은 GitHub secret에만 맞는 값이 있어(맥 .env의 BLOGGER_CLIENT_ID는 2026-10-27 기준 거부됨)
// `.github/workflows/tkm-rebrand.yml`(수동 실행)로 돌린다.
//
// 글은 **본문만**(posts.patch에 content만) 바꾼다 - 제목·라벨·발행일·검색 설명·공개 상태는 그대로. 페이지는 pages.patch로
// 제목·본문. 변환 전후가 "이름 치환뿐"인지(checkNameOnlyChange) 확인하고 아니면 건너뛰고 실패 목록에 올린다.
// 바꿀 게 없는 글·페이지는 건너뛴다(멱등). DB는 읽지도 쓰지도 않는다.

import { appendFileSync } from "node:fs";
import { KSCENE_BLOGGER_BLOG_ID } from "../../config/publishTargets.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import { TKM_BRAND_NAME } from "./tkmPostStructure.js";
import { countFormerName, rebrandTkmHtml } from "./tkmRebrand.js";

type Target = "all" | "posts" | "pages";
type Args = { apply: boolean; only: string | null; limit: number | null; target: Target };

function parseArgs(argv: string[]): Args {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=").trim() || null;
  const limit = value("limit");
  const target = value("target") ?? "all";
  if (!["all", "posts", "pages"].includes(target)) throw new Error(`--target은 all|posts|pages: ${target}`);
  return {
    apply: argv.includes("--apply"),
    only: value("only"),
    limit: limit ? Math.max(0, Number.parseInt(limit, 10)) || null : null,
    target: target as Target,
  };
}

type Item = { kind: "post" | "page"; id: string; url: string; title: string; html: string };

type Row = {
  kind: string;
  path: string;
  text: number;
  jsonLd: number;
  title: string;
  status: string;
};

function storedJsonLdNames(html: string): string[] {
  return [...html.matchAll(/"(?:author|publisher)":\{"@type":"Organization","name":"([^"]*)"/g)].map((match) => match[1]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!KSCENE_BLOGGER_BLOG_ID) throw new Error("KSCENE_BLOGGER_BLOG_ID가 없습니다");
  const client = new BloggerClient({ blogId: KSCENE_BLOGGER_BLOG_ID });

  const items: Item[] = [];
  if (args.target !== "pages") {
    const listed = await client.listLivePosts({ fetchBodies: true });
    if (!listed.ok) throw new Error(listed.error);
    for (const post of listed.posts) items.push({ kind: "post", id: post.id, url: post.url, title: post.title, html: post.content ?? "" });
  }
  if (args.target !== "posts") {
    const listed = await client.listPages({ fetchBodies: true });
    if (!listed.ok) throw new Error(listed.error);
    for (const page of listed.pages) items.push({ kind: "page", id: page.id, url: page.url, title: page.title, html: page.content ?? "" });
  }
  const targets = args.only ? items.filter((item) => item.id === args.only || item.url.includes(args.only!)) : items;
  if (targets.length === 0) throw new Error(`대상이 없습니다: ${args.only ?? args.target}`);

  const rows: Row[] = [];
  const failures: string[] = [];
  let applied = 0;

  for (const item of targets) {
    const path = new URL(item.url).pathname;
    const result = rebrandTkmHtml({ path, title: item.title, html: item.html });
    const row: Row = {
      kind: item.kind,
      path,
      text: result.textReplacements,
      jsonLd: result.jsonLdBlocks,
      title: result.titleChanged ? `${item.title} -> ${result.title}` : "-",
      status: "dry-run",
    };
    rows.push(row);

    if (!result.changed) {
      row.status = "unchanged";
      continue;
    }
    if (!result.check.ok) {
      row.status = "skip:not-name-only";
      failures.push(`${path} - ${result.check.reason}(건너뜀)`);
      continue;
    }
    if (result.unparsableJsonLd > 0) failures.push(`${path} - 파싱 안 되는 JSON-LD ${result.unparsableJsonLd}개(그대로 둠)`);
    if (!args.apply) continue;
    if (args.limit !== null && applied >= args.limit) {
      row.status = "pending(limit)";
      continue;
    }
    applied += 1;

    if (item.kind === "post") {
      const patched = await client.patchPostContent(item.id, result.html);
      if (!patched.ok) {
        row.status = "fail:patch";
        failures.push(`${path} - ${patched.error}`);
        continue;
      }
      const stored = await client.getPostContent(item.id);
      if (!stored.ok) {
        row.status = "warn:reread";
        failures.push(`${path} - 갱신 후 다시 읽기 실패: ${stored.error}`);
        continue;
      }
      const names = storedJsonLdNames(stored.content);
      const ok = countFormerName(stored.content) === 0 && names.every((name) => name === TKM_BRAND_NAME);
      row.status = ok ? `ok${names.length ? ` jsonld:${names.length}` : ""}` : "warn:stored-differs";
      if (!ok) failures.push(`${path} - 저장된 본문에 옛 이름이 남음(JSON-LD 이름: ${names.join(", ") || "없음"})`);
    } else {
      const patched = await client.patchPage(item.id, result.title, result.html);
      if (!patched.ok) {
        row.status = "fail:patch";
        failures.push(`${path} - ${patched.error}`);
        continue;
      }
      const stored = await client.getPage(item.id);
      if (!stored.ok) {
        row.status = "warn:reread";
        failures.push(`${path} - 갱신 후 다시 읽기 실패: ${stored.error}`);
        continue;
      }
      const ok = stored.title === result.title && countFormerName(stored.content) === 0;
      row.status = ok ? "ok" : "warn:stored-differs";
      if (!ok) failures.push(`${path} - 저장된 제목/본문이 기대와 다름(제목 "${stored.title}")`);
    }
  }

  const header = "| 종류 | 경로 | 본문 치환 | JSON-LD 블록 | 제목 | 상태 |\n|---|---|---|---|---|---|";
  const lines = rows.map((row) => `| ${row.kind} | ${row.path} | ${row.text} | ${row.jsonLd} | ${row.title} | ${row.status} |`);
  const changed = rows.filter((row) => row.status !== "unchanged");
  const totals = [
    `모드: ${args.apply ? "apply" : "dry-run"} · target=${args.target}${args.only ? ` · only=${args.only}` : ""}${args.limit !== null ? ` · limit=${args.limit}` : ""}`,
    `대상 ${rows.length}건(글 ${rows.filter((row) => row.kind === "post").length} · 페이지 ${rows.filter((row) => row.kind === "page").length}) · 바꿀 것 ${changed.length} · 변경 없음 ${rows.length - changed.length}`,
    `본문 치환 합계 ${rows.reduce((sum, row) => sum + row.text, 0)} · JSON-LD 블록 합계 ${rows.reduce((sum, row) => sum + row.jsonLd, 0)} · 제목 변경 ${rows.filter((row) => row.title !== "-").length}`,
    `적용 ${rows.filter((row) => row.status.startsWith("ok")).length}건 · 이름 외 변경으로 건너뜀 ${rows.filter((row) => row.status === "skip:not-name-only").length}건`,
    ...(failures.length > 0 ? ["", "실패/주의:", ...failures.map((failure) => `- ${failure}`)] : []),
  ];
  const report = [header, ...lines, "", ...totals].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Korea Plain 리브랜딩\n\n${report}\n`);
  if (failures.some((failure) => !failure.includes("파싱 안 되는"))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
