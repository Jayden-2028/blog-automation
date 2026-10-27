// Korea Plain 맞춤 도메인 전환(2026-10-28) - DB의 옛 blogspot 주소를 공개 주소(KSCENE_PUBLIC_ORIGIN)로. 기본은 dry-run.
//
//   npm run tkm:cutover-urls              # dry-run: 바뀔 행을 표로(쓰지 않음)
//   npm run tkm:cutover-urls -- --apply   # 실제 치환(원격 DB update - 승인 후 팀장이 실행)
//   npm run tkm:cutover-urls -- --verify  # 치환 대상 URL을 공개 주소로 바꿔 HEAD 200인지 전수 확인(읽기만)
//
// 대상 세 곳(호스트만 바꾸고 경로는 그대로):
//  (a) publications.published_url - 옛 호스트로 남은 발행 기록
//  (b) article_jobs.metadata - 사용설명서 job(track=kscene + TKM 발행 기록이 있는 job)의 metadata 안 문자열 전부를 훑는다.
//      코드가 URL을 남기는 자리: bingSubmit.urls(publishArticleToBlogspot·bing:submit), tkmStructure.allGuidesUrl(tkm:structure).
//      그 밖에 옛 주소가 든 문자열이 있으면 경로와 함께 표에 나온다.
//  (c) articles.content - 옛 주소가 든 원고(Related Guides 링크 등)
// 구 주소 자체(Blogger 301 소스)는 그대로 둔다. 역치환 모드는 없다 - 되돌릴 일이 있으면 적용 전 dry-run 표(전후 값)로 복원한다.

import "dotenv/config";
import { KSCENE_LEGACY_HOSTS, KSCENE_PUBLIC_ORIGIN, normalizeTkmUrl, rewriteTkmLegacyUrls } from "../../config/publishTargets.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { supabase } from "../../services/supabase/client.js";
import { changedTopLevel, fieldOf, rewriteLegacyUrlsDeep } from "./tkmCutover.js";
import type { LegacyHit } from "./tkmCutover.js";
import { TKM_ALL_GUIDES_PATH } from "./tkmPostStructure.js";

type Mode = "dry-run" | "apply" | "verify";

const LEGACY = KSCENE_LEGACY_HOSTS;
const legacyLike = (column: string) => LEGACY.map((host) => `${column}.ilike.*${host}*`).join(",");

type PublicationHit = { id: number; articleId: number; status: string; before: string; after: string };
type JobHit = { jobId: string; keyword: string; hits: LegacyHit[]; patch: Record<string, unknown> };
type ArticleHit = { id: number; jobId: string | null; platform: string | null; status: string; updatedAt: string; urls: number; next: string };

async function loadPublications(): Promise<PublicationHit[]> {
  const { data, error } = await supabase
    .from("publications")
    .select("id,article_id,status,published_url")
    .or(legacyLike("published_url"))
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as number,
    articleId: row.article_id as number,
    status: row.status as string,
    before: row.published_url as string,
    after: normalizeTkmUrl(row.published_url as string),
  }));
}

/** 사용설명서 job: track=kscene이거나 TKM 주소(옛·새)로 발행 기록이 있는 job. */
async function loadJobs(): Promise<JobHit[]> {
  const hosts = [new URL(KSCENE_PUBLIC_ORIGIN).host, ...LEGACY];
  const { data: pubs, error } = await supabase
    .from("publications")
    .select("article_id")
    .or(hosts.map((host) => `published_url.ilike.*${host}*`).join(","));
  if (error) throw error;
  const articleIds = [...new Set((pubs ?? []).map((row) => row.article_id as number))];
  const { data: articles, error: articleError } = articleIds.length
    ? await supabase.from("articles").select("job_id").in("id", articleIds)
    : { data: [], error: null };
  if (articleError) throw articleError;
  const publishedJobIds = new Set((articles ?? []).map((row) => row.job_id as string).filter(Boolean));

  const { data: tracked, error: trackError } = await supabase.from("article_jobs").select("id").eq("metadata->>track", "kscene");
  if (trackError) throw trackError;
  const jobIds = [...new Set([...publishedJobIds, ...(tracked ?? []).map((row) => row.id as string)])];

  const out: JobHit[] = [];
  for (let i = 0; i < jobIds.length; i += 50) {
    const { data: jobs, error: jobError } = await supabase.from("article_jobs").select("id,keyword,metadata").in("id", jobIds.slice(i, i + 50));
    if (jobError) throw jobError;
    for (const job of jobs ?? []) {
      const metadata = (job.metadata ?? {}) as Record<string, unknown>;
      const { value, hits } = rewriteLegacyUrlsDeep(metadata);
      if (hits.length === 0) continue;
      out.push({ jobId: job.id as string, keyword: job.keyword as string, hits, patch: changedTopLevel(metadata, value as Record<string, unknown>) });
    }
  }
  return out.sort((a, b) => a.jobId.localeCompare(b.jobId));
}

async function loadArticles(): Promise<ArticleHit[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id,job_id,platform,status,updated_at,content")
    .or(legacyLike("content"))
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const { text, count } = rewriteTkmLegacyUrls((row.content as string) ?? "");
    return {
      id: row.id as number,
      jobId: (row.job_id as string) ?? null,
      platform: (row.platform as string) ?? null,
      status: row.status as string,
      updatedAt: row.updated_at as string,
      urls: count,
      next: text,
    };
  });
}

function short(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function printTables(pubs: PublicationHit[], jobs: JobHit[], articles: ArticleHit[]): void {
  console.log(`공개 주소: ${KSCENE_PUBLIC_ORIGIN} · 옛 호스트: ${LEGACY.join(", ")}\n`);

  console.log(`(a) publications.published_url - ${pubs.length}행`);
  console.log("| id | article | status | 지금 | 바뀔 값 |\n|---|---|---|---|---|");
  for (const pub of pubs) console.log(`| ${pub.id} | ${pub.articleId} | ${pub.status} | ${short(pub.before)} | ${short(pub.after)} |`);

  const fields = new Map<string, number>();
  for (const job of jobs) for (const hit of job.hits) fields.set(fieldOf(hit.path), (fields.get(fieldOf(hit.path)) ?? 0) + 1);
  console.log(`\n(b) article_jobs.metadata - job ${jobs.length}개, 문자열 ${jobs.reduce((sum, job) => sum + job.hits.length, 0)}개`);
  console.log("| 필드 | 문자열 수 |\n|---|---|");
  for (const [field, count] of [...fields.entries()].sort((a, b) => b[1] - a[1])) console.log(`| ${field} | ${count} |`);
  console.log("\n| job | 키워드 | 바뀌는 자리 |\n|---|---|---|");
  for (const job of jobs) console.log(`| ${job.jobId.slice(0, 8)} | ${job.keyword} | ${job.hits.map((hit) => hit.path).join(", ")} |`);

  console.log(`\n(c) articles.content - 원고 ${articles.length}개, 옛 주소 ${articles.reduce((sum, article) => sum + article.urls, 0)}개`);
  console.log("| article | job | platform | status | 옛 주소 수 |\n|---|---|---|---|---|");
  for (const article of articles) {
    console.log(`| ${article.id} | ${article.jobId?.slice(0, 8) ?? "-"} | ${article.platform ?? "(기준)"} | ${article.status} | ${article.urls} |`);
  }
}

async function apply(pubs: PublicationHit[], jobs: JobHit[], articles: ArticleHit[]): Promise<number> {
  let failures = 0;
  for (const pub of pubs) {
    // 읽은 값 그대로일 때만 바꾼다(그 사이 다른 경로가 고쳤으면 건드리지 않는다).
    const { data, error } = await supabase
      .from("publications")
      .update({ published_url: pub.after })
      .eq("id", pub.id)
      .eq("published_url", pub.before)
      .select("id");
    if (error || (data ?? []).length !== 1) {
      failures += 1;
      console.error(`✗ publications ${pub.id}: ${error?.message ?? "행이 바뀌어 건너뜀"}`);
    }
  }
  for (const job of jobs) {
    try {
      await ArticleJobRepository.mergeMetadata(job.jobId, job.patch);
    } catch (error) {
      failures += 1;
      console.error(`✗ article_jobs ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const article of articles) {
    const { data, error } = await supabase
      .from("articles")
      .update({ content: article.next })
      .eq("id", article.id)
      .eq("updated_at", article.updatedAt)
      .select("id");
    if (error || (data ?? []).length !== 1) {
      failures += 1;
      console.error(`✗ articles ${article.id}: ${error?.message ?? "행이 바뀌어 건너뜀"}`);
    }
  }
  console.log(`\n적용: publications ${pubs.length} · article_jobs ${jobs.length} · articles ${articles.length} · 실패 ${failures}`);
  return failures;
}

type Probe = { url: string; status: string; ok: boolean };

async function head(url: string): Promise<{ status: number; location: string | null }> {
  const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15_000) });
  return { status: response.status, location: response.headers.get("location") };
}

/** HTTPS로 먼저, 연결 자체가 실패하면(인증서 발급 전) http로 다시 본다. 200이면 ok. */
async function probe(url: string): Promise<Probe> {
  try {
    const { status, location } = await head(url);
    return { url, status: `https ${status}${location ? ` → ${short(location)}` : ""}`, ok: status === 200 };
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    try {
      const { status, location } = await head(url.replace(/^https:/, "http:"));
      return { url, status: `https 실패(${reason}) / http ${status}${location ? ` → ${location}` : ""}`, ok: false };
    } catch (httpError) {
      return { url, status: `https 실패(${reason}) / http 실패(${httpError instanceof Error ? httpError.message : String(httpError)})`, ok: false };
    }
  }
}

async function verify(pubs: PublicationHit[], jobs: JobHit[]): Promise<number> {
  const urlRe = new RegExp(`${KSCENE_PUBLIC_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^\\s"'<>)]*`, "g");
  const urls = new Set<string>([`${KSCENE_PUBLIC_ORIGIN}/`, `${KSCENE_PUBLIC_ORIGIN}${TKM_ALL_GUIDES_PATH}`]);
  for (const pub of pubs) if (pub.status === "published") urls.add(pub.after);
  for (const job of jobs) for (const hit of job.hits) for (const match of hit.after.match(urlRe) ?? []) urls.add(match);
  // 이미 공개 주소로 바뀐 뒤에 돌려도 확인할 수 있게, 공개 주소로 남은 발행 기록도 넣는다.
  const { data, error } = await supabase
    .from("publications")
    .select("published_url")
    .eq("status", "published")
    .ilike("published_url", `%${new URL(KSCENE_PUBLIC_ORIGIN).host}%`);
  if (error) throw error;
  for (const row of data ?? []) urls.add(row.published_url as string);

  const results: Probe[] = [];
  for (const url of [...urls].sort()) results.push(await probe(url));
  console.log(`\n--verify: ${results.length}개 URL (200 = 통과)`);
  console.log("| URL | 결과 |\n|---|---|");
  for (const result of results) console.log(`| ${short(result.url)} | ${result.ok ? "✅ " : "❌ "}${result.status} |`);
  const bad = results.filter((result) => !result.ok).length;
  console.log(`\n통과 ${results.length - bad} / 실패 ${bad}`);
  return bad;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode: Mode = argv.includes("--apply") ? "apply" : argv.includes("--verify") ? "verify" : "dry-run";
  const [pubs, jobs, articles] = await Promise.all([loadPublications(), loadJobs(), loadArticles()]);
  console.log(`모드: ${mode}\n`);
  printTables(pubs, jobs, articles);
  if (mode === "apply") {
    if ((await apply(pubs, jobs, articles)) > 0) process.exitCode = 1;
  } else if (mode === "verify") {
    if ((await verify(pubs, jobs)) > 0) process.exitCode = 1;
  } else {
    console.log("\n(dry-run - 아무것도 쓰지 않았습니다. 적용: --apply / 공개 주소 응답 확인: --verify)");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
