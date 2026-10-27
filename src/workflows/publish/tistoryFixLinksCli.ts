// 티스토리 404 내부 링크 치환 CLI(2026-10-28). 2026-10-27 사건(발행 주소 18건이 404로 저장)의 옛 주소가 다른 글 본문에
// 내부 링크로 들어간 것을 새 주소로 바꾼다. 옛→새 18쌍은 교정 CLI 픽스처(tistoryDeadLinks.ts).
//
//   npm run tistory:fix-links                       # dry-run(기본): (a) 티스토리 발행 글 표(공개 페이지 GET으로 글 ID·옛 링크 수 확인)
//                                                   #                (b) articles.content에 옛 주소를 품은 글 표
//   npm run tistory:fix-links -- --scan-all         # 티스토리 발행 글 전체 공개 페이지를 훑어 DB 목록 밖의 옛 링크도 대상에 넣는다(--apply와 같이 써도 된다)
//   npm run tistory:fix-links -- --apply --limit 1  # 앞에서 1편만 실제 수정(TistoryPublisher.editPost, 맥미니 로그인 프로필 필요)
//   npm run tistory:fix-links -- --apply            # 전부 수정
//   npm run tistory:fix-links -- --db --dry-run     # articles.content 치환 diff 수만
//   npm run tistory:fix-links -- --db               # articles.content 치환(원격 DB update)
//
// --apply·--db는 실제 글 수정·원격 DB update다 - 팀장이 맥미니에서 dry-run → --limit 1 → 전체 순으로 실행한다.
// 멱등: 공개 페이지에 옛 링크가 없으면 "변경 없음"으로 건너뛰고, DB도 이미 새 주소면 바꾸지 않는다.
// --apply는 첫 실패(검증 실패·로그인 풀림 포함)에서 멈춘다 - 셀렉터·가정이 틀렸으면 같은 실패를 반복할 뿐이다.

import "dotenv/config";

import { TISTORY_CONFIG, tistoryBlogName } from "../../config/publishTargets.js";
import { supabase } from "../../services/supabase/client.js";
import { updateArticle } from "../../services/supabase/repositories/articleRepository.js";
import { TistoryPublisher, type TistoryEditResult } from "../../services/publish/tistory/TistoryPublisher.js";
import {
  countLinksTo,
  extractHrefs,
  extractTistoryPostId,
  hrefKey,
  planHrefReplacements,
  type HrefChange,
} from "../../services/publish/tistory/tistoryPostEdit.js";
import { findBodyHits, type BodyHit } from "./tistoryDeadLinkHits.js";
import { loadDeadLinkPairs, replaceDeadLinksInContent, type DeadLinkPair } from "./tistoryDeadLinks.js";
import { TISTORY_PLATFORM } from "./publishJobToTistory.js";

export const TISTORY_LINK_FIX_KEY = "tistoryLinkFix";

const GAP_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TistoryTarget = {
  publicationId: number;
  articleId: number;
  jobId: string;
  title: string;
  url: string;
  /** DB 본문 기준으로 이 글에 있어야 할 옛 링크(publications id). */
  deadUrlIds: number[];
};

type LiveCheck = { postId: number | null; postIdSource: string; httpOk: boolean; changes: HrefChange[] };

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readable(url: string): string {
  try {
    return decodeURI(url).replace(/^https:\/\/[^/]+/, "");
  } catch {
    return url.replace(/^https:\/\/[^/]+/, "");
  }
}

function parseArgs(argv: string[]) {
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : Infinity;
  if (limitIndex >= 0 && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit 뒤에는 1 이상의 정수를 주세요.");
  return {
    apply: argv.includes("--apply"),
    db: argv.includes("--db"),
    dryRun: argv.includes("--dry-run"),
    scanAll: argv.includes("--scan-all"),
    limit,
  };
}

/** 본문에 옛 주소를 품은 글(발행된 job)의 **티스토리 발행본**. 같은 job의 article row가 여럿이어도 발행 기록 단위로 하나. */
async function loadTistoryTargets(hits: BodyHit[]): Promise<TistoryTarget[]> {
  const byJob = new Map<string, BodyHit[]>();
  for (const hit of hits) if (hit.jobId && hit.jobPublished) byJob.set(hit.jobId, [...(byJob.get(hit.jobId) ?? []), hit]);
  if (byJob.size === 0) return [];
  const { data: jobArticles, error } = await supabase.from("articles").select("id, job_id, title").in("job_id", [...byJob.keys()]);
  if (error) throw error;
  const articleById = new Map((jobArticles ?? []).map((article) => [article.id, article]));
  const { data: pubs, error: pubError } = await supabase
    .from("publications")
    .select("id, article_id, published_url")
    .in("article_id", [...articleById.keys()])
    .eq("platform", TISTORY_PLATFORM)
    .eq("status", "published");
  if (pubError) throw pubError;
  return (pubs ?? [])
    .filter((pub) => pub.published_url)
    .map((pub) => {
      const article = articleById.get(pub.article_id)!;
      const jobHits = byJob.get(article.job_id as string) ?? [];
      return {
        publicationId: pub.id,
        articleId: pub.article_id,
        jobId: article.job_id as string,
        title: article.title ?? jobHits[0]?.title ?? "",
        url: pub.published_url as string,
        deadUrlIds: [...new Set(jobHits.flatMap((hit) => hit.deadUrlIds))].sort((a, b) => b - a),
      };
    })
    .sort((a, b) => b.articleId - a.articleId);
}

/** 티스토리 발행 글 전체(--scan-all). DB 본문 검색에 안 걸린 글도 공개 페이지로 확인한다. */
async function loadAllTistoryPublications(): Promise<TistoryTarget[]> {
  const { data: pubs, error } = await supabase
    .from("publications")
    .select("id, article_id, published_url")
    .eq("platform", TISTORY_PLATFORM)
    .eq("status", "published");
  if (error) throw error;
  const { data: articles, error: articleError } = await supabase
    .from("articles")
    .select("id, job_id, title")
    .in("id", [...new Set((pubs ?? []).map((pub) => pub.article_id))]);
  if (articleError) throw articleError;
  const byId = new Map((articles ?? []).map((article) => [article.id, article]));
  return (pubs ?? [])
    .filter((pub) => pub.published_url && byId.get(pub.article_id)?.job_id)
    .map((pub) => ({
      publicationId: pub.id,
      articleId: pub.article_id,
      jobId: byId.get(pub.article_id)!.job_id as string,
      title: byId.get(pub.article_id)!.title ?? "",
      url: pub.published_url as string,
      deadUrlIds: [],
    }));
}

/** 공개 페이지 GET(읽기 전용) - 글 ID와 옛 링크 자리. 비공개 글은 여기서 404라 --apply에서 로그인 컨텍스트로 다시 본다. */
async function checkLive(url: string, pairs: readonly DeadLinkPair[], host: string): Promise<LiveCheck> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (blog-automation fix-links)" } }).catch(() => null);
  if (!res || !res.ok) return { postId: null, postIdSource: res ? `HTTP ${res.status}` : "network", httpOk: false, changes: [] };
  const html = await res.text();
  const id = extractTistoryPostId(html);
  return { postId: id?.id ?? null, postIdSource: id?.source ?? "없음", httpOk: true, changes: planHrefReplacements(extractHrefs(html), pairs, host) };
}

/** --scan-all: DB 본문 검색에 안 걸린 티스토리 발행 글의 공개 페이지를 훑어 옛 링크가 있는 글을 더한다. */
async function scanOtherPublications(known: TistoryTarget[], pairs: readonly DeadLinkPair[], host: string): Promise<TistoryTarget[]> {
  const knownIds = new Set(known.map((target) => target.publicationId));
  const rest = (await loadAllTistoryPublications()).filter((target) => !knownIds.has(target.publicationId));
  const found: TistoryTarget[] = [];
  for (const target of rest) {
    if ((await checkLive(target.url, pairs, host)).changes.length > 0) found.push(target);
    await sleep(GAP_MS);
  }
  console.log(`  --scan-all: DB 목록 밖 티스토리 글 ${rest.length}편 중 옛 링크가 있는 글 ${found.length}편`);
  return found;
}

async function recordLinkFix(jobId: string, result: Extract<TistoryEditResult, { ok: true }>): Promise<void> {
  const { data: job, error } = await supabase.from("article_jobs").select("metadata").eq("id", jobId).maybeSingle();
  if (error) throw error;
  const metadata = (job?.metadata ?? {}) as Record<string, unknown>;
  const at = new Date().toISOString();
  const record = {
    at,
    postId: result.postId,
    verified: result.verified,
    changed: result.changedHrefs.map((change) => ({ from: change.from, to: change.to })),
  };
  const { error: updateError } = await supabase
    .from("article_jobs")
    .update({ metadata: { ...metadata, [TISTORY_LINK_FIX_KEY]: record }, updated_at: at })
    .eq("id", jobId);
  if (updateError) throw updateError;
}

async function runTistoryReport(targets: TistoryTarget[], pairs: readonly DeadLinkPair[], host: string, label: string): Promise<void> {
  console.log(`\n▶ (a) ${label} ${targets.length}편 - 공개 페이지 GET으로 글 ID·옛 링크 확인`);
  console.log("| article_id | pub | 글 주소 | 글 ID | 공개 페이지 옛 링크 | 옛 링크 → 새 링크 |");
  console.log("|---|---|---|---|---|---|");
  let totalLinks = 0;
  for (const target of targets) {
    const live = await checkLive(target.url, pairs, host);
    totalLinks += live.changes.length;
    const links = live.changes.map((change) => `${short(readable(change.from), 28)} → ${short(readable(change.to), 28)}`).join("<br>") || "-";
    const expected = target.deadUrlIds.length > 0 ? ` (DB: pub ${target.deadUrlIds.join(",")})` : "";
    console.log(
      `| ${target.articleId} | ${target.publicationId} | ${short(readable(target.url), 34)} | ${live.postId ?? "?"} (${live.postIdSource}) | ${live.httpOk ? live.changes.length : "확인 불가"}${expected} | ${links} |`
    );
    await sleep(GAP_MS);
  }
  console.log(`  공개 페이지 기준 옛 링크 합계 ${totalLinks}개`);
}

async function runDbFix(hits: BodyHit[], pairs: readonly DeadLinkPair[], host: string, apply: boolean): Promise<void> {
  console.log(`\n▶ (b) articles.content에 옛 주소를 품은 글 ${hits.length}편 ${apply ? "- 치환 실행" : "(dry-run)"}`);
  console.log("| article_id | 발행 | 제목 | 치환 수 | 옛 링크(pub) |");
  console.log("|---|---|---|---|---|");
  const fromToPub = new Map(pairs.map((pair) => [hrefKey(pair.from, host), pair.publicationId]));
  let changedArticles = 0;
  let changedLinks = 0;
  for (const hit of hits) {
    const { data, error } = await supabase.from("articles").select("content").eq("id", hit.articleId).maybeSingle();
    if (error) throw error;
    const before = data?.content ?? "";
    const { content, fixes } = replaceDeadLinksInContent(before, pairs, host);
    const count = fixes.reduce((sum, fix) => sum + fix.count, 0);
    const pubs = fixes.map((fix) => fromToPub.get(hrefKey(fix.from, host))).join(", ");
    console.log(`| ${hit.articleId} | ${hit.jobPublished ? "발행됨" : "-"} | ${short(hit.title, 34)} | ${count === 0 ? "변경 없음" : count} | ${pubs || "-"} |`);
    if (count === 0) continue;
    changedArticles += 1;
    changedLinks += count;
    if (apply) await updateArticle(hit.articleId, { content });
  }
  console.log(`  ${apply ? "치환 완료" : "치환 예정"}: ${changedArticles}편 / 링크 ${changedLinks}개${apply ? "" : " (DB는 바꾸지 않았습니다)"}`);
}

async function runApply(targets: TistoryTarget[], pairs: readonly DeadLinkPair[], host: string, limit: number): Promise<void> {
  const froms = pairs.map((pair) => pair.from);
  const publisher = new TistoryPublisher();
  const rows: string[] = [];
  let edited = 0;
  let stopped = false;
  for (const target of targets) {
    if (stopped || edited >= limit) {
      rows.push(`| ${target.articleId} | ${short(readable(target.url), 34)} | - | 미실행 | |`);
      continue;
    }
    // 공개 페이지에 옛 링크가 없으면 브라우저를 띄우지 않는다(멱등). 비공개 글(HTTP 404)은 editPost가 로그인 컨텍스트로 본다.
    const live = await checkLive(target.url, pairs, host);
    if (live.httpOk && live.changes.length === 0) {
      rows.push(`| ${target.articleId} | ${short(readable(target.url), 34)} | ${live.postId ?? "?"} | 변경 없음(건너뜀) | |`);
      continue;
    }

    let planned: HrefChange[] = [];
    const result = await publisher.editPost({
      postUrl: target.url,
      mutate: (ctx) => {
        planned = planHrefReplacements(ctx.hrefs, pairs, ctx.host);
        if (planned.length === 0 && countLinksTo(ctx.publicHtml, froms, ctx.host) > 0) {
          return { hrefChanges: [], abort: "공개 페이지에는 옛 링크가 있는데 에디터 본문의 a에서 찾지 못했습니다(본문이 다르게 열렸을 수 있음)." };
        }
        return { hrefChanges: planned };
      },
      verify: (html) => {
        const oldLeft = countLinksTo(html, froms, host);
        const newFound = planned.filter((change) => countLinksTo(html, [change.to], host) > 0).length;
        return { ok: oldLeft === 0 && newFound === planned.length, detail: `옛 링크 ${oldLeft}개 남음, 새 링크 ${newFound}/${planned.length}` };
      },
    });
    edited += 1;

    if (!result.ok) {
      const status = result.stage === "login" ? "deferred(로그인 풀림)" : `실패(${result.stage})`;
      rows.push(`| ${target.articleId} | ${short(readable(target.url), 34)} | ${result.postId ?? "?"} | ${status} | ${short(result.error, 80)} |`);
      stopped = true;
      continue;
    }
    if (result.noChange) {
      rows.push(`| ${target.articleId} | ${short(readable(target.url), 34)} | ${result.postId} | 변경 없음 | ${result.verifyDetail ?? ""} |`);
      continue;
    }
    await recordLinkFix(target.jobId, result);
    const status = result.verified ? "성공" : "검증 실패(저장됨)";
    const detail = `${result.changedHrefs.length}개 치환, 공개범위 #${result.visibility}, 버튼 "${result.buttonText}"; ${result.verifyDetail ?? ""}${result.warnings.length ? `; ⚠️ ${result.warnings.join(" / ")}` : ""}`;
    rows.push(`| ${target.articleId} | ${short(readable(target.url), 34)} | ${result.postId} | ${status} | ${detail} |`);
    if (!result.verified) stopped = true;
    await sleep(GAP_MS);
  }
  console.log("\n| article_id | 글 주소 | 글 ID | 결과 | 상세 |");
  console.log("|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  if (stopped) console.log("\n⚠️ 성공이 아닌 결과에서 멈췄습니다. 실패 스냅샷: .local/dom-snapshots/tistory/failures/");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply && args.db) throw new Error("--apply(티스토리 글 수정)와 --db(articles.content 치환)는 따로 실행하세요.");
  const blogName = tistoryBlogName(TISTORY_CONFIG.blogUrl);
  if (!blogName) throw new Error(`TISTORY_BLOG_URL이 올바르지 않습니다: ${TISTORY_CONFIG.blogUrl}`);
  const host = `${blogName}.tistory.com`;

  const pairs = loadDeadLinkPairs();
  const hits = await findBodyHits(pairs.map((pair) => ({ id: pair.publicationId, currentUrl: pair.from })));
  const mode = args.apply ? `APPLY${Number.isFinite(args.limit) ? ` --limit ${args.limit}` : ""}` : args.db ? (args.dryRun ? "DB dry-run" : "DB APPLY") : "dry-run";
  console.log(`▶ [tistory:fix-links] ${mode} - 옛→새 주소 ${pairs.length}쌍, 옛 주소를 본문에 품은 글 ${hits.length}편(발행된 job ${hits.filter((hit) => hit.jobPublished).length}편)`);

  if (args.db) {
    await runDbFix(hits, pairs, host, !args.dryRun);
    return;
  }

  const targets = await loadTistoryTargets(hits);
  const extra = args.scanAll ? await scanOtherPublications(targets, pairs, host) : [];
  if (args.apply) {
    await runApply([...targets, ...extra], pairs, host, args.limit);
    return;
  }

  await runTistoryReport(targets, pairs, host, "티스토리 발행 글(DB 본문 기준)");
  if (extra.length > 0) await runTistoryReport(extra, pairs, host, "DB 목록 밖에서 찾은 글(--scan-all)");
  await runDbFix(hits, pairs, host, false);
  console.log("\n(dry-run - 티스토리 글과 DB를 바꾸지 않았습니다. 실행은 맥미니에서 --apply --limit 1 → --apply, DB는 --db)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
