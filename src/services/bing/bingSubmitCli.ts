// Bing URL Submission 수동 CLI(2026-10-27) - 백필·재제출·할당량 확인.
//
//   npm run bing:submit -- --quota                      # 잔여 할당량(일/월)
//   npm run bing:submit -- --urls <url>,<url>           # 지정한 URL 제출
//   npm run bing:submit -- --job-id <id>                # 그 job의 공개 글 URL + All Guides 제출(결과를 job.metadata.bingSubmit에 기록)
//   옵션: --site=<siteUrl>  (기본: BING_SITE_URL, 없으면 첫 URL의 origin, URL도 없으면 KSCENE_PUBLIC_ORIGIN)
// TKM 주소는 옛 blogspot 표기로 줘도 공개 주소(www.koreaplain.com)로 바꿔 제출한다(normalizeTkmUrl).
//
// 키는 BING_WEBMASTER_API_KEY(.env). 없으면 아무것도 보내지 않고 안내만 출력한다. 키 값은 출력하지 않는다.

import "dotenv/config";
import { KSCENE_PUBLIC_ORIGIN, normalizeTkmUrl } from "../../config/publishTargets.js";
import { TKM_ALL_GUIDES_PATH } from "../../workflows/publish/tkmPostStructure.js";
import { BingWebmasterClient, resolveBingSiteUrl } from "./BingWebmasterClient.js";

function option(argv: string[], name: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.split("=").slice(1).join("=").trim() || null;
  const index = argv.indexOf(`--${name}`);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next.trim() : null;
}

async function urlsOfJob(jobId: string): Promise<string[]> {
  const [{ listArticlesByJobId }, { listPublicationsByArticleIds }] = await Promise.all([
    import("../supabase/repositories/articleRepository.js"),
    import("../supabase/repositories/publicationRepository.js"),
  ]);
  const articles = await listArticlesByJobId(jobId);
  const publications = await listPublicationsByArticleIds(articles.map((article) => article.id));
  const published = publications.find((pub) => pub.status === "published" && pub.published_url);
  if (!published?.published_url) throw new Error(`공개 발행된 글이 없습니다: ${jobId}`);
  const postUrl = normalizeTkmUrl(published.published_url);
  const siteUrl = resolveBingSiteUrl(postUrl);
  return [postUrl, `${siteUrl?.replace(/\/$/, "")}${TKM_ALL_GUIDES_PATH}`];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const client = new BingWebmasterClient();
  const jobId = option(argv, "job-id");
  let urls = (option(argv, "urls") ?? "").split(",").map((url) => normalizeTkmUrl(url.trim())).filter(Boolean);
  if (jobId) urls = await urlsOfJob(jobId);

  const siteUrl = resolveBingSiteUrl(urls[0] ?? KSCENE_PUBLIC_ORIGIN, option(argv, "site") ?? process.env.BING_SITE_URL);
  if (!siteUrl) {
    console.error("siteUrl을 알 수 없습니다. --urls/--job-id를 주거나 --site= 또는 BING_SITE_URL을 설정하세요.");
    process.exit(1);
  }

  if (argv.includes("--quota")) {
    const quota = await client.getQuota(siteUrl);
    console.log(JSON.stringify({ siteUrl, ...quota }, null, 2));
    if (!("skipped" in quota) && !quota.ok) process.exit(1);
    return;
  }

  if (urls.length === 0) {
    console.error("사용법: npm run bing:submit -- --quota | --urls <url,...> | --job-id <id>");
    process.exit(1);
  }
  const result = await client.submitUrls(siteUrl, urls);
  console.log(JSON.stringify({ siteUrl, urls, ...result }, null, 2));

  if (jobId && !("skipped" in result)) {
    const { ArticleJobRepository } = await import("../../repositories/ArticleJobRepository.js");
    const record = { at: new Date().toISOString(), urls, ok: result.ok, ...(result.ok ? {} : { error: result.error }) };
    await ArticleJobRepository.mergeMetadata(jobId, { bingSubmit: record });
    console.log("job.metadata.bingSubmit 기록");
  }
  if (!("skipped" in result) && !result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
