// 티스토리 발행본 적립 CLI(2026-11-05 사용자 지시). 하루 1회 블로그 RSS를 읽어 "실제로 올라간 글"을
// publications에 적립한다. 왜 필요한지는 tistoryPublishedInventory.ts 머리말에 있다.
//
//   npm run tistory:inventory                 # dry-run(기본): 적립할 목록만 보여준다
//   npm run tistory:inventory -- --apply      # publications insert/update + job.metadata 갱신
//   npm run tistory:inventory -- --apply --notify   # 바뀐 게 있으면 사회 봇으로 요약을 보낸다
//   npm run tistory:inventory -- --limit=300  # 제목을 맞춰 볼 article 수(기본 600)
//
// ⚠️ `--apply`는 **원격 DB 쓰기**다(CLAUDE.md 승인 항목). 하는 일은 두 가지뿐이고 둘 다 더하기다:
//   ① 티스토리 publication 행이 없는 article에 `status=published` 행을 **insert**
//   ② 행은 있는데 주소가 비었거나 다른 경우 `published_url`/`published_at`을 **update**
// 글을 발행하지도, 지우지도, 원고를 고치지도 않는다. 되돌리기 = 그 행을 지우거나 주소를 되돌리는 것이다.
//
// 멱등하다 - 같은 날 두 번 돌려도 두 번째는 "이미 적립"으로 지나간다.
import "dotenv/config";

import { tistoryBlogName } from "../../config/publishTargets.js";
import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { supabase } from "../../services/supabase/client.js";
import { TISTORY_PLATFORM } from "./publishJobToTistory.js";
import { TISTORY_REQUEST_KEY, readTistoryRequest } from "./tistoryPublishQueue.js";
import {
  inventorySummary,
  normalizeUrl,
  parseTistoryRss,
  planInventory,
  type InventoryArticle,
  type InventoryPlan,
  type TistoryFeedItem,
} from "./tistoryPublishedInventory.js";

const DEFAULT_ARTICLE_LIMIT = 600;

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function numberOption(name: string, fallback: number): number {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function fetchRss(blogName: string): Promise<string> {
  const res = await fetch(`https://${blogName}.tistory.com/rss`, {
    headers: { "user-agent": "blog-automation-tistory-inventory" },
  });
  if (!res.ok) throw new Error(`RSS 조회 실패: HTTP ${res.status}`);
  return res.text();
}

/** 제목을 맞춰 볼 후보(최근 article + 그 article의 티스토리 publication). */
async function loadCandidates(limit: number): Promise<InventoryArticle[]> {
  const { data: articles, error } = await supabase
    .from("articles")
    .select("id, job_id, title")
    .not("title", "is", null)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`article 조회 실패: ${error.message}`);

  const rows = (articles ?? []).filter((row) => row.job_id && row.title);
  if (rows.length === 0) return [];

  const { data: pubs, error: pubError } = await supabase
    .from("publications")
    .select("id, article_id, published_url, status")
    .eq("platform", TISTORY_PLATFORM)
    .in("article_id", rows.map((row) => row.id as number));
  if (pubError) throw new Error(`publication 조회 실패: ${pubError.message}`);

  // article 하나에 행이 여럿일 수 있다(재발행) - **주소가 있는 행**을 우선하고, 그 중 최신(id 큰 것)을 본다.
  const pubByArticle = new Map<number, { id: number; published_url: string | null }>();
  for (const pub of [...(pubs ?? [])].sort((a, b) => (a.id as number) - (b.id as number))) {
    const articleId = pub.article_id as number;
    const current = pubByArticle.get(articleId);
    if (!current || pub.published_url || !current.published_url) {
      pubByArticle.set(articleId, { id: pub.id as number, published_url: (pub.published_url as string) ?? null });
    }
  }

  return rows.map((row) => {
    const pub = pubByArticle.get(row.id as number);
    return {
      articleId: row.id as number,
      jobId: row.job_id as string,
      title: row.title as string,
      ...(pub ? { publicationId: pub.id, recordedUrl: pub.published_url } : {}),
    };
  });
}

function shortTitle(title: string, max = 46): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function printPlan(plan: InventoryPlan, items: readonly TistoryFeedItem[], apply: boolean): void {
  console.log(`\n${inventorySummary(plan, items.length)}`);
  if (plan.actions.length > 0) {
    console.log(`\n${apply ? "적립합니다" : "적립 대상(dry-run)"}:`);
    for (const action of plan.actions) {
      const mark = action.kind === "record" ? "＋" : "✎";
      console.log(`  ${mark} ${action.item.publishedAt?.slice(0, 16) ?? "시각미상"} ${shortTitle(action.item.title)}`);
      console.log(`     ${decodeURI(action.item.url)}`);
    }
  }
  if (plan.unmatched.length > 0) {
    console.log(`\n미확인(제목으로 우리 원고를 못 찾음) ${plan.unmatched.length}건:`);
    for (const item of plan.unmatched.slice(0, 20)) {
      console.log(`  ? ${item.publishedAt?.slice(0, 16) ?? "시각미상"} ${shortTitle(item.title)}`);
    }
    if (plan.unmatched.length > 20) console.log(`  … 그 외 ${plan.unmatched.length - 20}건`);
  }
}

/** publications 행을 만들거나 주소를 맞추고, job.metadata의 요청 상태를 done으로 닫는다. */
async function applyPlan(plan: InventoryPlan): Promise<{ recorded: number; fixed: number; failed: number }> {
  let recorded = 0;
  let fixed = 0;
  let failed = 0;

  for (const action of plan.actions) {
    const publishedAt = action.item.publishedAt ?? new Date().toISOString();
    try {
      if (action.kind === "record") {
        const { error } = await supabase.from("publications").insert({
          article_id: action.article.articleId,
          platform: TISTORY_PLATFORM,
          status: "published",
          published_url: action.item.url,
          published_at: publishedAt,
        });
        if (error) throw new Error(error.message);
        recorded += 1;
      } else {
        const { error } = await supabase
          .from("publications")
          .update({ status: "published", published_url: action.item.url, published_at: publishedAt })
          .eq("id", action.publicationId);
        if (error) throw new Error(error.message);
        fixed += 1;
      }
      await closeRequest(action.article.jobId, action.item.url, publishedAt);
    } catch (error) {
      failed += 1;
      console.error(`❌ 적립 실패(${shortTitle(action.item.title, 30)}): ${error instanceof Error ? error.message : error}`);
    }
  }
  return { recorded, fixed, failed };
}

/**
 * job.metadata.tistoryPublish를 done으로 닫는다. 임시저장 모드에서는 요청이 `draft`로 끝나 있는데,
 * 사람이 발행한 뒤에도 그대로면 "아직 안 올라갔다"로 보인다.
 * 이미 done이면 건드리지 않는다 - 폴러가 확정한 주소(urlSource)가 더 정확하다.
 */
async function closeRequest(jobId: string, url: string, finishedAt: string): Promise<void> {
  const { data, error } = await supabase.from("article_jobs").select("id, metadata").eq("id", jobId).maybeSingle();
  if (error || !data) return;
  const existing = readTistoryRequest({ metadata: (data.metadata as Record<string, unknown> | null) ?? {} });
  if (existing?.status === "done" && existing.url && normalizeUrl(existing.url) === normalizeUrl(url)) return;

  const metadata = { ...((data.metadata as Record<string, unknown>) ?? {}) };
  metadata[TISTORY_REQUEST_KEY] = {
    ...(existing ?? {}),
    status: "done",
    requestedAt: existing?.requestedAt ?? "",
    finishedAt,
    url,
    urlSource: "rss-inventory",
  };
  const { error: updateError } = await supabase.from("article_jobs").update({ metadata }).eq("id", jobId);
  if (updateError) console.warn(`⚠️ 요청 상태 갱신 실패(무시): ${updateError.message}`);
}

function notifyText(plan: InventoryPlan, items: readonly TistoryFeedItem[], result: { recorded: number; fixed: number }): string {
  const lines = [
    "📒 <b>티스토리 발행본 적립</b>",
    "",
    escapeTelegramHtml(inventorySummary(plan, items.length)),
  ];
  const recorded = plan.actions.filter((action) => action.kind === "record");
  if (recorded.length > 0) {
    lines.push("", "<b>새로 적립한 글</b>");
    for (const action of recorded.slice(0, 8)) {
      lines.push(`· ${escapeTelegramHtml(shortTitle(action.item.title, 38))}`);
    }
    if (recorded.length > 8) lines.push(`· 그 외 ${recorded.length - 8}건`);
  }
  if (plan.unmatched.length > 0) {
    lines.push("", `제목으로 원고를 못 찾은 글이 ${plan.unmatched.length}건 있습니다(티스토리에서 직접 쓰거나 제목을 고친 글).`);
  }
  if (result.recorded + result.fixed === 0) lines.push("", "DB에 바뀐 것은 없습니다.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const apply = flag("apply");
  const notify = flag("notify");
  const limit = numberOption("limit", DEFAULT_ARTICLE_LIMIT);
  const blogName = tistoryBlogName();
  if (!blogName) throw new Error("티스토리 블로그 이름이 설정되지 않았습니다(TISTORY_BLOG_NAME).");

  console.log(`📒 티스토리 발행본 적립 - ${blogName}.tistory.com RSS 읽기${apply ? " (적용)" : " (dry-run)"}`);
  const items = parseTistoryRss(await fetchRss(blogName));
  if (items.length === 0) throw new Error("RSS에서 글을 찾지 못했습니다(형식이 바뀌었을 수 있습니다).");

  const candidates = await loadCandidates(limit);
  const plan = planInventory(items, candidates);
  printPlan(plan, items, apply);

  let result = { recorded: 0, fixed: 0, failed: 0 };
  if (apply && plan.actions.length > 0) {
    result = await applyPlan(plan);
    console.log(`\n✅ 적립 ${result.recorded}건, 주소 교정 ${result.fixed}건${result.failed > 0 ? `, 실패 ${result.failed}건` : ""}`);
  } else if (!apply) {
    console.log("\nℹ️ dry-run입니다. 실제로 적립하려면 --apply를 붙이세요.");
  }

  // 바뀐 게 없고 미확인도 없으면 알리지 않는다 - 날마다 같은 메시지가 오면 읽지 않게 된다.
  if (notify && (plan.actions.length > 0 || plan.unmatched.length > 0)) {
    await TelegramNotifier.fromEnv("social")
      .sendMessages([{ text: notifyText(plan, items, result) }])
      .catch((error) => console.warn(`⚠️ 알림 실패(무시): ${error instanceof Error ? error.message : error}`));
  }

  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`❌ [tistory-inventory] 실패: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
