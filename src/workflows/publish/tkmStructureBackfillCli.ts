// Korea Plain 기존 글 일괄 구조 보강(2026-10-27). 기본은 dry-run - 아무것도 쓰지 않고 글마다 바뀔 내용을 출력한다.
//
//   npm run tkm:structure                               # dry-run(전 글)
//   npm run tkm:structure -- --apply --only=<postId>    # 한 편만 실제 적용(+ All Guides 페이지 재생성)
//   npm run tkm:structure -- --apply                    # 전 글 적용
//   옵션: --jsonld(본문 JSON-LD 포함, 실험·확정 뒤) / --no-page(All Guides 재생성 생략)
//         --rewrite-host(맞춤 도메인 전환, 2026-10-28): 본문 안 옛 blogspot 절대 URL을 공개 주소(KSCENE_PUBLIC_ORIGIN)로 바꾸고,
//           이미 JSON-LD가 있는 글은 --jsonld 없이도 새 주소로 다시 만든다(없이 돌리면 걷힌다). 고정 페이지(About 등)의
//           옛 주소도 같은 규칙으로 바꾼다. Related 블록·All Guides 허브는 옵션과 무관하게 늘 공개 주소로 만든다.
//
// 운영 자격 증명은 GitHub secret에만 맞는 값이 있어(맥 .env의 BLOGGER_CLIENT_ID는 2026-10-27 기준 거부됨)
// `.github/workflows/tkm-structure-backfill.yml`(수동 실행)로 돌린다.
//
// 바꾸는 것은 **본문만**이다(posts.patch에 content만 보낸다) - 제목·라벨·발행일·검색 설명·공개 상태는 그대로.
// 글마다 변환 전후 읽히는 글자가 같은지(우리 블록 제외) 확인하고, 다르면 그 글은 건너뛰고 실패 목록에 올린다.
// 적용한 글은 job.metadata.tkmStructure에 언제·무엇을 남긴다(발행 기록 publications의 URL로 job을 찾는다).

import { appendFileSync } from "node:fs";
import { KSCENE_BLOGGER_BLOG_ID, KSCENE_LEGACY_HOSTS, KSCENE_PUBLIC_ORIGIN, rewriteTkmLegacyUrls } from "../../config/publishTargets.js";
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
import { bloggerTkmSiteDeps, findAllGuidesPage, syncAllGuidesPage } from "./tkmSite.js";

type Args = { apply: boolean; only: string | null; jsonld: boolean; page: boolean; rewriteHost: boolean };

function parseArgs(argv: string[]): Args {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=").trim() || null;
  return {
    apply: argv.includes("--apply"),
    only: value("only"),
    jsonld: argv.includes("--jsonld"),
    page: !argv.includes("--no-page"),
    rewriteHost: argv.includes("--rewrite-host"),
  };
}

type JobRef = { jobId: string; searchDescription: string | null };

/** 이 블로그의 호스트들(공개 주소 + 옛 blogspot). 발행 기록이 어느 쪽 주소로 남아 있든 찾는다. */
const TKM_HOSTS = [new URL(KSCENE_PUBLIC_ORIGIN).host, ...KSCENE_LEGACY_HOSTS];

/** 공개 URL -> job·영어 검색 설명(읽기 전용). publications에 이 블로그 주소로 남은 발행 기록만 본다. */
async function loadJobRefs(): Promise<Map<string, JobRef>> {
  const { data: pubs, error } = await supabase
    .from("publications")
    .select("article_id,published_url")
    .eq("status", "published")
    .or(TKM_HOSTS.map((host) => `published_url.like.*${host}*`).join(","));
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
  /** 본문에서 공개 주소로 바꾼 옛 blogspot 절대 URL 수(--rewrite-host). */
  hostRewrites: number;
  /** 결과 본문에 남은 옛 blogspot 절대 URL 수(0이어야 한다). */
  legacyLeft: number;
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
  const refs = await loadJobRefs();

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
    // --rewrite-host: 옛 주소를 먼저 바꾼 본문을 기준으로 삼는다 - 글자 비교도 이 기준과 한다(주소 글자만 바뀌는 것은 의도).
    const rewritten = args.rewriteHost ? rewriteTkmLegacyUrls(before) : { text: before, count: 0 };
    const source = rewritten.text;
    // 이미 JSON-LD가 든 글은 옵션과 무관하게 다시 만든다(2026-10-30). 전에는 --jsonld 없이 돌리면 조용히 걷혔다 -
    // 43편 전부에 들어 있어서 소급 실행 한 번에 구조화 데이터가 사라질 수 있었다. 새로 넣는 것만 --jsonld가 정한다.
    const withJsonLd = args.jsonld || /\btkm-jsonld\b/.test(before);
    const result = applyTkmStructure(source, {
      related: pickTkmRelated(post, tkmPosts, page.url),
      jsonLd: withJsonLd
        ? {
            url: post.url,
            headline: post.title,
            description: describePost(source, ref?.searchDescription),
            datePublished: post.published,
            dateModified: now,
            imageUrl: firstImageUrl(source),
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
      hostRewrites: rewritten.count,
      legacyLeft: rewriteTkmLegacyUrls(result.html).count,
      changed: result.html !== before,
      textOk: sameVisibleText(source, result.html),
      status: "dry-run",
    };
    rows.push(row);

    if (!row.textOk) {
      row.status = "skip:text-mismatch";
      failures.push(`${row.path} - 변환 전후 글자가 다름(건너뜀)`);
      continue;
    }
    if (args.rewriteHost && row.legacyLeft > 0) {
      row.status = "skip:legacy-left";
      failures.push(`${row.path} - 옛 주소 ${row.legacyLeft}개가 남음(건너뜀)`);
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
      legacy: rewriteTkmLegacyUrls(storedHtml).count,
    };
    const storedOk = kept.related && kept.h2 >= result.h2Count && (!args.rewriteHost || kept.legacy === 0);
    row.status = storedOk ? `ok${withJsonLd ? (kept.jsonLd ? " jsonld:kept" : " jsonld:STRIPPED") : ""}` : "warn:stored-differs";
    if (row.status === "warn:stored-differs") failures.push(`${row.path} - 저장된 본문에 블록/h2/주소가 기대와 다름(h2 ${kept.h2}, 옛 주소 ${kept.legacy})`);

    if (ref) {
      await ArticleJobRepository.mergeMetadata(ref.jobId, {
        tkmStructure: {
          updatedAt: now,
          postId: post.id,
          h2: kept.h2,
          upgradedHeadings: result.upgradedHeadings,
          relatedLinks: result.relatedLinks,
          jsonLd: withJsonLd ? kept.jsonLd : false,
          allGuidesUrl: page.url,
          ...(args.rewriteHost ? { hostRewrittenTo: KSCENE_PUBLIC_ORIGIN, hostRewrites: rewritten.count } : {}),
        },
      }).catch((error) => failures.push(`${row.path} - 갱신 기록 실패: ${error instanceof Error ? error.message : String(error)}`));
    } else {
      failures.push(`${row.path} - 발행 기록(publications)에서 job을 못 찾아 갱신 기록을 남기지 못함(본문은 갱신됨)`);
    }
  }

  const pageLines = args.rewriteHost ? await rewritePagesHost(client, args.apply, failures) : [];

  const header = "| post | h2 전→후 | 변환 | 링크 | JSON-LD | 주소 교체 | 남은 옛 주소 | 변경 | 글자 | 상태 |\n|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map(
    (row) =>
      `| ${row.path} | ${row.h2Before}→${row.h2After} | ${row.upgraded} | ${row.links} | ${row.jsonLd ? "Y" : "-"} | ${row.hostRewrites} | ${row.legacyLeft} | ${row.changed ? "Y" : "-"} | ${row.textOk ? "OK" : "DIFF"} | ${row.status} |`
  );
  const totals = [
    `모드: ${args.apply ? "apply" : "dry-run"}${args.only ? ` (only=${args.only})` : ""}${args.jsonld ? " + jsonld" : ""}${args.rewriteHost ? ` + rewrite-host(→ ${KSCENE_PUBLIC_ORIGIN})` : ""}`,
    `대상 ${rows.length}편 · 변경 ${rows.filter((row) => row.changed).length} · 글자 불일치 ${rows.filter((row) => !row.textOk).length}`,
    `h2 변환 합계 ${rows.reduce((sum, row) => sum + row.upgraded, 0)} · 링크 합계 ${rows.reduce((sum, row) => sum + row.links, 0)} · 최소 h2 ${Math.min(...rows.map((row) => row.h2After))} · 최소 링크 ${Math.min(...rows.map((row) => row.links))}`,
    `All Guides: ${page.action} ${page.url ?? ""}`,
    ...(args.rewriteHost
      ? [
          `주소 교체 합계 ${rows.reduce((sum, row) => sum + row.hostRewrites, 0)} · 남은 옛 주소 합계 ${rows.reduce((sum, row) => sum + row.legacyLeft, 0)}`,
          "",
          "고정 페이지(옛 주소 교체):",
          ...(pageLines.length > 0 ? pageLines : ["- (옛 주소가 든 페이지 없음)"]),
        ]
      : []),
    ...(failures.length > 0 ? ["", "실패/주의:", ...failures.map((failure) => `- ${failure}`)] : []),
  ];
  const report = [header, ...lines, "", ...totals].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## TKM 구조 보강\n\n${report}\n`);
  if (failures.some((failure) => !failure.includes("갱신 기록"))) process.exitCode = 1;
}

/**
 * 고정 페이지(About·Contact 등)의 옛 blogspot 절대 URL을 공개 주소로(--rewrite-host). All Guides는 syncAllGuidesPage가 다시 만들므로 뺀다.
 * 주소 문자열 말고는 아무것도 바꾸지 않는다. 돌려주는 값은 보고용 줄.
 */
async function rewritePagesHost(client: BloggerClient, apply: boolean, failures: string[]): Promise<string[]> {
  const listed = await client.listPages({ fetchBodies: true });
  if (!listed.ok) {
    failures.push(`고정 페이지 목록: ${listed.error}`);
    return [];
  }
  const hub = findAllGuidesPage(listed.pages);
  const lines: string[] = [];
  for (const page of listed.pages) {
    if (page.id === hub?.id || !page.content) continue;
    const { text: next, count } = rewriteTkmLegacyUrls(page.content);
    if (count === 0) continue;
    const label = new URL(page.url).pathname;
    if (!apply) {
      lines.push(`- ${label} "${page.title}": 옛 주소 ${count}개 → 교체 예정`);
      continue;
    }
    const patched = await client.patchPage(page.id, page.title, next);
    if (!patched.ok) {
      failures.push(`${label} - 페이지 갱신 실패: ${patched.error}`);
      continue;
    }
    const stored = await client.getPage(page.id);
    const left = stored.ok ? rewriteTkmLegacyUrls(stored.content).count : -1;
    lines.push(`- ${label} "${page.title}": 옛 주소 ${count}개 교체${left === 0 ? "" : ` (확인: 남은 옛 주소 ${left})`}`);
    if (left !== 0) failures.push(`${label} - 저장된 페이지에 옛 주소가 남음(${left})`);
  }
  return lines;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
