// 티스토리 발행 주소 점검·교정 CLI(2026-10-27). 발행 직후 주소를 슬러그 그대로 저장하던 시절의 404 기록을 찾아 고친다
// (원인과 새 확정 순서는 services/publish/tistory/tistoryPublishedUrl.ts 머리말).
//
//   npm run tistory:url-audit                      # dry-run(기본): 전 행 HEAD 검사 -> 404 행의 교정 주소·근거 표 + 옛 주소를 본문에 품은 글 목록
//   npm run tistory:url-audit -- --apply           # publications.published_url + job.metadata.tistoryPublish.url 교정(+ urlCorrectedAt)
//   npm run tistory:url-audit -- --rewrite-bodies  # 본문 치환 대상 목록만 출력한다(치환은 npm run tistory:fix-links)
//
// --apply는 원격 DB update다 - 사용자 승인 뒤에만 실행한다. 교정 주소를 찾지 못한(또는 검증 못 한) 행은 건드리지 않는다.
// 네트워크 호출(HEAD·검색·RSS)은 읽기 전용이고 행당 0.3초 간격을 둔다.

import "dotenv/config";

import { TISTORY_CONFIG, tistoryBlogName } from "../../config/publishTargets.js";
import { supabase } from "../../services/supabase/client.js";
import {
  fetchHeadStatus,
  matchRssLink,
  resolveUrlFromSearch,
  resolveUrlFromSlug,
  slugFromEntryUrl,
  type TistoryUrlSource,
} from "../../services/publish/tistory/tistoryPublishedUrl.js";
import { TISTORY_PLATFORM } from "./publishJobToTistory.js";
import { TISTORY_REQUEST_KEY } from "./tistoryPublishQueue.js";
import { findBodyHits } from "./tistoryDeadLinkHits.js";

const GAP_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AuditRow = {
  id: number;
  articleId: number;
  jobId: string | null;
  title: string;
  status: string;
  currentUrl: string;
  httpStatus: number;
  fixUrl: string | null;
  fixSource: Exclude<TistoryUrlSource, "page-url" | "manage-list" | "slug-unverified"> | null;
  note?: string;
};


function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function decoded(url: string | null): string {
  if (!url) return "-";
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

async function loadRows(): Promise<Omit<AuditRow, "httpStatus" | "fixUrl" | "fixSource">[]> {
  const { data: pubs, error } = await supabase
    .from("publications")
    .select("id, article_id, status, published_url")
    .eq("platform", TISTORY_PLATFORM)
    .order("id", { ascending: false });
  if (error) throw error;
  const articleIds = [...new Set((pubs ?? []).map((pub) => pub.article_id))];
  const { data: articles, error: articleError } = await supabase.from("articles").select("id, job_id, title").in("id", articleIds);
  if (articleError) throw articleError;
  const byId = new Map((articles ?? []).map((article) => [article.id, article]));
  return (pubs ?? [])
    .filter((pub) => pub.published_url)
    .map((pub) => ({
      id: pub.id,
      articleId: pub.article_id,
      jobId: byId.get(pub.article_id)?.job_id ?? null,
      title: byId.get(pub.article_id)?.title ?? "",
      status: pub.status,
      currentUrl: pub.published_url as string,
    }));
}

async function applyFix(row: AuditRow, correctedAt: string): Promise<void> {
  const { error } = await supabase.from("publications").update({ published_url: row.fixUrl }).eq("id", row.id);
  if (error) throw error;
  if (!row.jobId) return;
  const { data: job, error: jobError } = await supabase.from("article_jobs").select("metadata").eq("id", row.jobId).maybeSingle();
  if (jobError) throw jobError;
  const metadata = (job?.metadata ?? {}) as Record<string, unknown>;
  const request = metadata[TISTORY_REQUEST_KEY];
  if (!request || typeof request !== "object") return;
  const patched = { ...(request as Record<string, unknown>), url: row.fixUrl, urlCorrectedAt: correctedAt };
  const { error: updateError } = await supabase
    .from("article_jobs")
    .update({ metadata: { ...metadata, [TISTORY_REQUEST_KEY]: patched }, updated_at: correctedAt })
    .eq("id", row.jobId);
  if (updateError) throw updateError;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const rewriteBodies = argv.includes("--rewrite-bodies");
  const blogName = tistoryBlogName(TISTORY_CONFIG.blogUrl);
  if (!blogName) throw new Error(`TISTORY_BLOG_URL이 올바르지 않습니다: ${TISTORY_CONFIG.blogUrl}`);

  const base = await loadRows();
  console.log(`▶ [tistory:url-audit] ${apply ? "APPLY" : "dry-run"} - 티스토리 발행 기록 ${base.length}건 HEAD 검사`);

  const rows: AuditRow[] = [];
  for (const row of base) {
    rows.push({ ...row, httpStatus: await fetchHeadStatus(row.currentUrl), fixUrl: null, fixSource: null });
    await sleep(GAP_MS);
  }
  const dead = rows.filter((row) => row.httpStatus !== 200);
  const byStatus = rows.reduce<Record<string, number>>((acc, row) => ((acc[row.httpStatus] = (acc[row.httpStatus] ?? 0) + 1), acc), {});
  console.log(`  HEAD 결과: ${JSON.stringify(byStatus)} -> 교정 대상 ${dead.length}건\n`);

  // ③ RSS(한 번만 받아 둔다 - 최근 글만 담긴다) ④ 검색 ⑤ 슬러그 다듬기 + HEAD
  const rss = await fetch(`https://${blogName}.tistory.com/rss`).then((res) => (res.ok ? res.text() : "")).catch(() => "");
  for (const row of dead) {
    const fromRss = row.title ? matchRssLink(rss, row.title) : null;
    if (fromRss && (await fetchHeadStatus(fromRss)) === 200) {
      Object.assign(row, { fixUrl: fromRss, fixSource: "rss" });
      continue;
    }
    const fromSearch = row.title ? await resolveUrlFromSearch(blogName, row.title) : null;
    await sleep(GAP_MS);
    if (fromSearch && (await fetchHeadStatus(fromSearch)) === 200) {
      Object.assign(row, { fixUrl: fromSearch, fixSource: "search" });
      continue;
    }
    const slug = slugFromEntryUrl(row.currentUrl);
    const guess = slug ? await resolveUrlFromSlug(blogName, slug) : null;
    await sleep(GAP_MS);
    if (guess?.verified) Object.assign(row, { fixUrl: guess.url, fixSource: "slug-verified" });
    else row.note = guess ? `추정 주소도 ${decoded(guess.url)} 404 - 수동 확인 필요` : "슬러그를 읽지 못함";
  }

  console.log("| id | article_id | 제목 | 현재 주소(HTTP) | 교정 주소 | 근거 |");
  console.log("|---|---|---|---|---|---|");
  for (const row of dead) {
    console.log(
      `| ${row.id} | ${row.articleId} | ${short(row.title, 34)} | ${short(decoded(row.currentUrl).replace(/^https:\/\/[^/]+/, ""), 50)} (${row.httpStatus}) | ${row.fixUrl ? decoded(row.fixUrl).replace(/^https:\/\/[^/]+/, "") : "-"} | ${row.fixSource ?? row.note ?? "-"} |`
    );
  }
  const fixable = dead.filter((row) => row.fixUrl);
  const sources = fixable.reduce<Record<string, number>>((acc, row) => ((acc[row.fixSource!] = (acc[row.fixSource!] ?? 0) + 1), acc), {});
  console.log(`\n  교정 주소 확보 ${fixable.length}/${dead.length}건 ${JSON.stringify(sources)}`);

  const hits = await findBodyHits(dead);
  console.log(`\n▶ 옛(404) 주소를 본문(articles.content)에 품은 글 ${hits.length}편 (그중 발행된 job ${hits.filter((hit) => hit.jobPublished).length}편)`);
  for (const hit of hits) {
    console.log(`  - article ${hit.articleId}${hit.jobPublished ? " [발행됨]" : ""} ${short(hit.title, 40)} <- 404 링크: publications ${hit.deadUrlIds.join(", ")}`);
  }

  if (rewriteBodies) {
    console.log(
      "\n⚠️ --rewrite-bodies는 목록만 출력합니다 - 위 목록이 치환 대상입니다." +
        "\n   articles.content 치환과 티스토리 실제 글 본문 수정은 npm run tistory:fix-links(dry-run 기본, 맥미니에서 실행)."
    );
  }

  if (!apply) {
    console.log("\n(dry-run - DB는 바꾸지 않았습니다. 교정하려면 사용자 승인 뒤 --apply)");
    return;
  }
  const correctedAt = new Date().toISOString();
  for (const row of fixable) {
    await applyFix(row, correctedAt);
    console.log(`  ✅ publications ${row.id} -> ${decoded(row.fixUrl)}`);
  }
  console.log(`\n✅ ${fixable.length}건 교정 완료(urlCorrectedAt=${correctedAt})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
