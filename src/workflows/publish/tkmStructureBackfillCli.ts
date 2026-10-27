// Korea Plain 기존 글 일괄 구조 보강(2026-10-27). 기본은 dry-run - 아무것도 쓰지 않고 글마다 바뀔 내용을 출력한다.
//
//   npm run tkm:structure                               # dry-run(전 글)
//   npm run tkm:structure -- --apply --only=<postId>    # 한 편만 실제 적용(+ All Guides 페이지 재생성)
//   npm run tkm:structure -- --apply                    # 전 글 적용
//   옵션: --jsonld(본문 JSON-LD 포함, 실험·확정 뒤) / --no-page(All Guides 재생성 생략)
//
// 운영 자격 증명은 GitHub secret에만 맞는 값이 있어(맥 .env의 BLOGGER_CLIENT_ID는 2026-10-27 기준 거부됨)
// `.github/workflows/tkm-structure-backfill.yml`(수동 실행)로 돌린다.
//
// 바꾸는 것은 **본문만**이다(posts.patch에 content만 보낸다) - 제목·라벨·발행일·검색 설명·공개 상태는 그대로.
// 글마다 변환 전후 읽히는 글자가 같은지(우리 블록 제외) 확인하고, 다르면 그 글은 건너뛰고 실패 목록에 올린다.
// 적용한 글은 job.metadata.tkmStructure에 언제·무엇을 남긴다(발행 기록 publications의 URL로 job을 찾는다).

import { appendFileSync } from "node:fs";
import { KSCENE_BLOGGER_BLOG_ID } from "../../config/publishTargets.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import type { BloggerListedPost } from "../../services/publish/blogger/BloggerClient.js";
import { supabase } from "../../services/supabase/client.js";
import {
  applyTkmStructure,
  describePost,
  firstImageUrl,
  normalizePostUrl,
  pickTkmRelated,
  sameVisibleText,
  siteOrigin,
} from "./tkmPostStructure.js";
import type { TkmPost } from "./tkmPostStructure.js";
import { bloggerTkmSiteDeps, syncAllGuidesPage } from "./tkmSite.js";

type Args = { apply: boolean; only: string | null; jsonld: boolean; page: boolean };

function parseArgs(argv: string[]): Args {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=").trim() || null;
  return {
    apply: argv.includes("--apply"),
    only: value("only"),
    jsonld: argv.includes("--jsonld"),
    page: !argv.includes("--no-page"),
  };
}

type JobRef = { jobId: string; searchDescription: string | null };

/** 공개 URL -> job·영어 검색 설명(읽기 전용). publications에 이 블로그 주소로 남은 발행 기록만 본다. */
async function loadJobRefs(host: string): Promise<Map<string, JobRef>> {
  const { data: pubs, error } = await supabase
    .from("publications")
    .select("article_id,published_url")
    .eq("status", "published")
    .like("published_url", `%${host}%`);
  if (error) throw error;
  const { data: articles, error: articleError } = await supabase
    .from("articles")
    .select("id,job_id")
    .in("id", (pubs ?? []).map((row) => row.article_id));
  if (articleError) throw articleError;
  const jobByArticle = new Map((articles ?? []).map((row) => [row.id as number, row.job_id as string]));
  const jobIds = [...new Set([...jobByArticle.values()])];
  // metadata 전체를 받지 않고 검색 설명 한 칸만 꺼낸다(egress). 문자열 변수로 넘겨 select 타입 추론 깊이 오류를 피한다.
  const columns: string = "id,sd:metadata->channelMeta->blogspot->>searchDescription";
  const { data: jobs, error: jobError } = await supabase.from("article_jobs").select(columns).in("id", jobIds);
  if (jobError) throw jobError;
  const descByJob = new Map(((jobs ?? []) as unknown as { id: string; sd: string | null }[]).map((row) => [row.id, row.sd ?? null]));

  const refs = new Map<string, JobRef>();
  for (const pub of pubs ?? []) {
    const jobId = jobByArticle.get(pub.article_id as number);
    if (!jobId || !pub.published_url) continue;
    refs.set(normalizePostUrl(pub.published_url as string), { jobId, searchDescription: descByJob.get(jobId) ?? null });
  }
  return refs;
}

type Row = {
  postId: string;
  path: string;
  h2Before: number;
  h2After: number;
  upgraded: number;
  links: number;
  jsonLd: boolean;
  changed: boolean;
  textOk: boolean;
  status: string;
};

function countH2(html: string): number {
  return (html.match(/<h2\b/gi) ?? []).length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!KSCENE_BLOGGER_BLOG_ID) throw new Error("KSCENE_BLOGGER_BLOG_ID가 없습니다");
  const client = new BloggerClient({ blogId: KSCENE_BLOGGER_BLOG_ID });
  const site = bloggerTkmSiteDeps(client);

  const listed = await client.listLivePosts({ fetchBodies: true });
  if (!listed.ok) throw new Error(listed.error);
  const posts: BloggerListedPost[] = listed.posts;
  const tkmPosts: TkmPost[] = posts.map((post) => ({ url: post.url, title: post.title, labels: post.labels, published: post.published }));
  const origin = siteOrigin(posts[0]?.url ?? "");
  if (!origin) throw new Error("공개 글이 없습니다");
  const refs = await loadJobRefs(new URL(origin).host);

  const page = args.page
    ? await syncAllGuidesPage(site, tkmPosts, { dryRun: !args.apply })
    : { url: (await syncAllGuidesPage(site, tkmPosts, { dryRun: true })).url, action: "skipped" as const };
  console.log(`· All Guides: ${page.action} ${page.url ?? "(주소 없음)"}`);
  if (args.apply && args.page && !page.url) throw new Error("All Guides 페이지 주소를 얻지 못했습니다");

  const targets = args.only ? posts.filter((post) => post.id === args.only || post.url.includes(args.only!)) : posts;
  if (targets.length === 0) throw new Error(`대상 글이 없습니다: ${args.only}`);
  const now = new Date().toISOString();
  const rows: Row[] = [];
  const failures: string[] = [];

  for (const post of targets) {
    const before = post.content ?? "";
    const ref = refs.get(normalizePostUrl(post.url)) ?? null;
    const result = applyTkmStructure(before, {
      related: pickTkmRelated(post, tkmPosts, page.url),
      jsonLd: args.jsonld
        ? {
            url: post.url,
            headline: post.title,
            description: describePost(before, ref?.searchDescription),
            datePublished: post.published,
            dateModified: now,
            imageUrl: firstImageUrl(before),
          }
        : null,
    });
    const row: Row = {
      postId: post.id,
      path: new URL(post.url).pathname,
      h2Before: countH2(before),
      h2After: result.h2Count,
      upgraded: result.upgradedHeadings,
      links: result.relatedLinks,
      jsonLd: result.hasJsonLd,
      changed: result.html !== before,
      textOk: sameVisibleText(before, result.html),
      status: "dry-run",
    };
    rows.push(row);

    if (!row.textOk) {
      row.status = "skip:text-mismatch";
      failures.push(`${row.path} - 변환 전후 글자가 다름(건너뜀)`);
      continue;
    }
    if (!args.apply) continue;
    if (!row.changed) {
      row.status = "unchanged";
      continue;
    }

    const patched = await client.patchPostContent(post.id, result.html);
    if (!patched.ok) {
      row.status = "fail:patch";
      failures.push(`${row.path} - ${patched.error}`);
      continue;
    }
    const stored = await client.getPostContent(post.id);
    const storedHtml = stored.ok ? stored.content : "";
    const kept = {
      related: storedHtml.includes("tkm-related"),
      h2: countH2(storedHtml),
      jsonLd: /application\/ld\+json/i.test(storedHtml),
    };
    row.status = kept.related && kept.h2 >= result.h2Count ? `ok${args.jsonld ? (kept.jsonLd ? " jsonld:kept" : " jsonld:STRIPPED") : ""}` : "warn:stored-differs";
    if (row.status === "warn:stored-differs") failures.push(`${row.path} - 저장된 본문에 블록/h2가 기대와 다름(h2 ${kept.h2})`);

    if (ref) {
      await ArticleJobRepository.mergeMetadata(ref.jobId, {
        tkmStructure: {
          updatedAt: now,
          postId: post.id,
          h2: kept.h2,
          upgradedHeadings: result.upgradedHeadings,
          relatedLinks: result.relatedLinks,
          jsonLd: args.jsonld ? kept.jsonLd : false,
          allGuidesUrl: page.url,
        },
      }).catch((error) => failures.push(`${row.path} - 갱신 기록 실패: ${error instanceof Error ? error.message : String(error)}`));
    } else {
      failures.push(`${row.path} - 발행 기록(publications)에서 job을 못 찾아 갱신 기록을 남기지 못함(본문은 갱신됨)`);
    }
  }

  const header = "| post | h2 전→후 | 변환 | 링크 | JSON-LD | 변경 | 글자 | 상태 |\n|---|---|---|---|---|---|---|---|";
  const lines = rows.map(
    (row) => `| ${row.path} | ${row.h2Before}→${row.h2After} | ${row.upgraded} | ${row.links} | ${row.jsonLd ? "Y" : "-"} | ${row.changed ? "Y" : "-"} | ${row.textOk ? "OK" : "DIFF"} | ${row.status} |`
  );
  const totals = [
    `모드: ${args.apply ? "apply" : "dry-run"}${args.only ? ` (only=${args.only})` : ""}${args.jsonld ? " + jsonld" : ""}`,
    `대상 ${rows.length}편 · 변경 ${rows.filter((row) => row.changed).length} · 글자 불일치 ${rows.filter((row) => !row.textOk).length}`,
    `h2 변환 합계 ${rows.reduce((sum, row) => sum + row.upgraded, 0)} · 링크 합계 ${rows.reduce((sum, row) => sum + row.links, 0)} · 최소 h2 ${Math.min(...rows.map((row) => row.h2After))} · 최소 링크 ${Math.min(...rows.map((row) => row.links))}`,
    `All Guides: ${page.action} ${page.url ?? ""}`,
    ...(failures.length > 0 ? ["", "실패/주의:", ...failures.map((failure) => `- ${failure}`)] : []),
  ];
  const report = [header, ...lines, "", ...totals].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## TKM 구조 보강\n\n${report}\n`);
  if (failures.some((failure) => !failure.includes("갱신 기록"))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
