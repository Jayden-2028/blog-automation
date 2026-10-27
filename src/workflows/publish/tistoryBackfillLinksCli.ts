// 기존 티스토리 발행 글에 "함께 보면 좋은 글" 내부 링크 블록을 소급해 넣는 CLI(2026-10-28).
// 순수 함수(선정·블록 HTML·자리·멱등·확인)는 tistoryRelatedBackfill.ts, 실제 수정은 TistoryPublisher.editPost(블록 추가 계획).
//
//   npm run tistory:backfill-links                         # dry-run(기본): 글별 선정표 + 집계. 네트워크는 공개 페이지 GET만
//   npm run tistory:backfill-links -- --only 753           # 특정 글(article_id)만
//   npm run tistory:backfill-links -- --apply --limit 1    # 앞에서 1편만 실제 수정(맥미니 로그인 프로필 필요)
//   npm run tistory:backfill-links -- --apply              # 전부 수정
//
// --apply는 실제 글 수정 + article_jobs.metadata.tistoryRelatedBackfill 기록(원격 DB update)이다 - 팀장이 맥미니에서
// dry-run → --apply --limit 1 → 공개 페이지 확인 → --apply 순으로 실행한다.
// 멱등: 공개 페이지(없으면 에디터 본문)에 이미 블록이 있으면 skip(already-has-block). 후보가 없으면 skip(no-candidates).
// 멈춤: 로그인 풀림(deferred)·저장 확인 실패(publish 단계)·저장 뒤 공개 페이지 확인 실패는 즉시, 그 밖의 실패(발행 안 함)는 연속 3번.

import "dotenv/config";

import { TISTORY_CONFIG, tistoryBlogName } from "../../config/publishTargets.js";
import { supabase } from "../../services/supabase/client.js";
import { listPublishedPosts, type PublishedPost } from "../../services/supabase/repositories/publicationRepository.js";
import { TistoryPublisher, type TistoryEditResult } from "../../services/publish/tistory/TistoryPublisher.js";
import { extractTistoryPostId } from "../../services/publish/tistory/tistoryPostEdit.js";
import type { RelatedLink } from "../manuscripts/appendRelatedPosts.js";
import { TISTORY_PLATFORM } from "./publishJobToTistory.js";
import {
  blocksFromPublicHtml,
  findRelatedInsertPosition,
  hasRelatedBlock,
  planRelatedInsertion,
  POSITION_LABEL,
  selectBackfillLinks,
  verifyRelatedOnPublicPage,
  type InsertPosition,
} from "./tistoryRelatedBackfill.js";

export const TISTORY_RELATED_BACKFILL_KEY = "tistoryRelatedBackfill";

const DRY_RUN_GAP_MS = 300;
const APPLY_GAP_MIN_MS = 3_000;
const APPLY_GAP_MAX_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Target = {
  publicationId: number;
  articleId: number;
  jobId: string;
  title: string;
  url: string;
  keyword: string;
  category: string | null;
  links: RelatedLink[];
};

type LiveCheck = { httpOk: boolean; status: string; postId: number | null; hasBlock: boolean; position: InsertPosition | null };

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
  const valueOf = (flag: string): number | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = Number(argv[index + 1]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} 뒤에는 1 이상의 정수를 주세요.`);
    return value;
  };
  return { apply: argv.includes("--apply"), limit: valueOf("--limit") ?? Infinity, only: valueOf("--only") };
}

/** 티스토리 발행 글 전부(publications 행 단위, 최신순) + 글마다 같은 블로그 관련 글. */
async function loadTargets(host: string): Promise<{ targets: Target[]; candidates: PublishedPost[] }> {
  const { data: pubs, error } = await supabase
    .from("publications")
    .select("id, article_id, published_url, created_at")
    .eq("platform", TISTORY_PLATFORM)
    .eq("status", "published")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (pubs ?? []).filter((pub) => pub.published_url);
  const { data: articles, error: articleError } = await supabase
    .from("articles")
    .select("id, job_id, title")
    .in("id", [...new Set(rows.map((pub) => pub.article_id))]);
  if (articleError) throw articleError;
  const articleById = new Map((articles ?? []).map((article) => [article.id as number, article]));
  const jobIds = [...new Set((articles ?? []).map((article) => article.job_id as string).filter(Boolean))];
  const { data: jobs, error: jobError } = await supabase.from("article_jobs").select("id, keyword, category").in("id", jobIds);
  if (jobError) throw jobError;
  const jobById = new Map((jobs ?? []).map((job) => [job.id as string, job]));

  const candidates = await listPublishedPosts(1000, { platform: TISTORY_PLATFORM });
  const targets: Target[] = [];
  for (const pub of rows) {
    const article = articleById.get(pub.article_id as number);
    const job = article ? jobById.get(article.job_id as string) : undefined;
    if (!article || !job) continue;
    const base = {
      publicationId: pub.id as number,
      articleId: pub.article_id as number,
      jobId: job.id as string,
      title: (article.title as string) ?? (job.keyword as string),
      url: pub.published_url as string,
      keyword: (job.keyword as string) ?? "",
      category: (job.category as string) ?? null,
    };
    targets.push({ ...base, links: selectBackfillLinks(base, candidates, host) });
  }
  return { targets, candidates };
}

/** 공개 페이지 GET(읽기 전용) - 글 ID·블록 유무·삽입 자리 예측. 비공개 글은 404라 --apply에서 editPost가 로그인 컨텍스트로 본다. */
async function checkLive(url: string): Promise<LiveCheck> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (blog-automation backfill-links)" } }).catch(() => null);
  if (!res || !res.ok) return { httpOk: false, status: res ? `HTTP ${res.status}` : "network", postId: null, hasBlock: false, position: null };
  const html = await res.text();
  const blocks = blocksFromPublicHtml(html);
  return {
    httpOk: true,
    status: "200",
    postId: extractTistoryPostId(html)?.id ?? null,
    hasBlock: blocks ? hasRelatedBlock(blocks) : false,
    position: blocks ? findRelatedInsertPosition(blocks) : null,
  };
}

function linkCell(links: readonly RelatedLink[]): string {
  return links.map((link, index) => `${index + 1}. ${short(link.title, 30)} (${short(readable(link.url), 26)})`).join("<br>") || "-";
}

async function runDryRun(targets: Target[]): Promise<void> {
  console.log("| article_id | 글 주소 | 글 ID | 관련 글(제목·주소) | 삽입 위치 | 판정 |");
  console.log("|---|---|---|---|---|---|");
  const tally = { target: 0, already: 0, noCandidates: 0, unknown: 0 };
  const positions: Record<string, number> = {};
  for (const target of targets) {
    const live = await checkLive(target.url);
    let verdict: string;
    if (target.links.length === 0) {
      verdict = "skip: no-candidates";
      tally.noCandidates += 1;
    } else if (live.hasBlock) {
      verdict = "skip: already-has-block";
      tally.already += 1;
    } else if (!live.httpOk || !live.position) {
      verdict = `대상(공개 페이지 확인 불가: ${live.httpOk ? "본문 영역 없음" : live.status})`;
      tally.target += 1;
      tally.unknown += 1;
    } else {
      verdict = "대상";
      tally.target += 1;
    }
    const position = live.position ? POSITION_LABEL[live.position.kind] : "?";
    if (verdict === "대상") positions[position] = (positions[position] ?? 0) + 1;
    console.log(
      `| ${target.articleId} | ${short(readable(target.url), 34)} | ${live.postId ?? "?"} | ${linkCell(target.links)} | ${position} | ${verdict} |`
    );
    await sleep(DRY_RUN_GAP_MS);
  }
  const positionSummary = Object.entries(positions).map(([label, count]) => `${label} ${count}`).join(", ") || "-";
  console.log(
    `\n집계: 전체 ${targets.length}편 - 대상 ${tally.target}(공개 페이지 확인 불가 ${tally.unknown}) / 건너뜀(already-has-block) ${tally.already} / 후보 없음 ${tally.noCandidates}`
  );
  console.log(`삽입 위치(공개 페이지 기준 예측): ${positionSummary}`);
  console.log("\n(dry-run - 티스토리 글과 DB를 바꾸지 않았습니다. 실행은 맥미니에서 --apply --limit 1 → 공개 페이지 확인 → --apply)");
}

async function recordBackfill(jobId: string, result: Extract<TistoryEditResult, { ok: true }>, links: readonly RelatedLink[]): Promise<void> {
  const { data: job, error } = await supabase.from("article_jobs").select("metadata").eq("id", jobId).maybeSingle();
  if (error) throw error;
  const metadata = (job?.metadata ?? {}) as Record<string, unknown>;
  const at = new Date().toISOString();
  const record = { at, postId: result.postId, verified: result.verified, links: links.map((link) => ({ title: link.title, url: link.url })) };
  const { error: updateError } = await supabase
    .from("article_jobs")
    .update({ metadata: { ...metadata, [TISTORY_RELATED_BACKFILL_KEY]: record }, updated_at: at })
    .eq("id", jobId);
  if (updateError) throw updateError;
}

async function runApply(targets: Target[], limit: number, host: string): Promise<void> {
  const publisher = new TistoryPublisher();
  const rows: string[] = [];
  const row = (target: Target, postId: number | string, status: string, detail = "") =>
    rows.push(`| ${target.articleId} | ${short(readable(target.url), 34)} | ${postId} | ${status} | ${detail} |`);
  let edited = 0;
  let consecutiveFailures = 0;
  let stopReason: string | null = null;

  for (const target of targets) {
    if (stopReason || edited >= limit) {
      row(target, "-", "미실행");
      continue;
    }
    if (target.links.length === 0) {
      row(target, "-", "skip: no-candidates");
      continue;
    }
    // 공개 페이지에 이미 블록이 있으면 브라우저를 띄우지 않는다. 비공개 글(404)은 editPost가 에디터 본문으로 다시 판정한다.
    const live = await checkLive(target.url);
    if (live.httpOk && live.hasBlock) {
      row(target, live.postId ?? "?", "skip: already-has-block");
      continue;
    }

    if (edited > 0) await sleep(APPLY_GAP_MIN_MS + Math.floor(Math.random() * (APPLY_GAP_MAX_MS - APPLY_GAP_MIN_MS)));
    let position: InsertPosition | undefined;
    const result = await publisher.editPost({
      postUrl: target.url,
      mutate: (ctx) => {
        const plan = planRelatedInsertion(ctx.blocks, target.links);
        position = plan.position;
        return plan;
      },
      verify: (html) => verifyRelatedOnPublicPage(html, target.links, host),
    });
    edited += 1;

    if (!result.ok) {
      if (result.stage === "login") {
        row(target, result.postId ?? "?", "deferred(로그인 풀림)", short(result.error, 80));
        stopReason = "로그인 풀림 - 맥미니에서 npm run setup:tistory 뒤 다시 실행하세요(멱등).";
        continue;
      }
      const label = ["invariant", "plan", "mutate"].includes(result.stage) ? "검증 실패(발행 안 함)" : `실패(${result.stage})`;
      row(target, result.postId ?? "?", label, short(result.error, 100));
      consecutiveFailures += 1;
      // 저장 버튼을 누른 뒤의 실패는 상태가 불확실하다 - 바로 멈추고 공개 페이지를 사람이 확인한다.
      if (result.stage === "publish") stopReason = "저장 확인 실패(publish 단계) - 공개 페이지를 확인하세요.";
      else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopReason = `연속 ${MAX_CONSECUTIVE_FAILURES}번 실패 - 셀렉터·가정을 점검하세요.`;
      continue;
    }
    consecutiveFailures = 0;
    if (result.noChange) {
      row(target, result.postId, "skip: already-has-block", "에디터 본문 기준");
      continue;
    }
    await recordBackfill(target.jobId, result, target.links);
    const where = position ? POSITION_LABEL[position.kind] : "?";
    const detail = `${result.insertedHrefs.length}개 추가(${where}), 공개범위 #${result.visibility}, 버튼 "${result.buttonText}"; ${result.verifyDetail ?? ""}${result.warnings.length ? `; ⚠️ ${result.warnings.join(" / ")}` : ""}`;
    if (result.verified) {
      row(target, result.postId, "성공", detail);
    } else {
      row(target, result.postId, "검증 실패(저장됨)", detail);
      stopReason = "저장은 됐지만 공개 페이지에서 블록을 확인하지 못했습니다 - 그 글을 직접 확인하세요.";
    }
  }

  console.log("\n| article_id | 글 주소 | 글 ID | 결과 | 상세 |");
  console.log("|---|---|---|---|---|");
  for (const line of rows) console.log(line);
  if (stopReason) console.log(`\n⚠️ 멈춤: ${stopReason}\n   실패 스냅샷: .local/dom-snapshots/tistory/failures/`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const blogName = tistoryBlogName(TISTORY_CONFIG.blogUrl);
  if (!blogName) throw new Error(`TISTORY_BLOG_URL이 올바르지 않습니다: ${TISTORY_CONFIG.blogUrl}`);
  const host = `${blogName}.tistory.com`;

  const { targets: all, candidates } = await loadTargets(host);
  const targets = args.only ? all.filter((target) => target.articleId === args.only) : all;
  if (args.only && targets.length === 0) throw new Error(`article_id ${args.only}인 티스토리 발행 글이 없습니다.`);
  const mode = args.apply ? `APPLY${Number.isFinite(args.limit) ? ` --limit ${args.limit}` : ""}` : "dry-run";
  console.log(
    `▶ [tistory:backfill-links] ${mode}${args.only ? ` --only ${args.only}` : ""} - 티스토리 발행 글 ${targets.length}편, 관련 글 후보(같은 블로그) ${candidates.length}편`
  );

  if (args.apply) await runApply(targets, args.limit, host);
  else await runDryRun(targets);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
