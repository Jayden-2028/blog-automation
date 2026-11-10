// 사용설명서(koreaplain) 발행본의 비공공 출처 이미지를 AI 삽화로 소급 교체한다.
//
// 왜 필요한가: 발행본 66건에 언론사 사진(imgnews.naver.net 등)과 상업 블로그 이미지가 섞여 있다. 출처 표기만 있고
// 라이선스는 없으며, 파일은 우리 Pages 도메인에서 서비스된다. 신규 원고는 PR #69가 공공 출처 화이트리스트
// (`koreaplainImageSources.ts`)로 막았고, 이 도구가 **이미 발행된 글**을 같은 기준으로 맞춘다.
// 교체 대상은 웹 수집 이미지 중 화이트리스트를 못 넘는 자리다(2026-11-10 실측 64건 268장, 생성 비용 장당 약 $0.0036).
//
// 글자·숫자가 정보인 자리(버튼 숫자·요금표·안내 표지·노선도)는 **그리지 않는다** - AI가 틀린 숫자를 사실처럼 그려 넣는다.
// LLM이 skip으로 판정한 자리는 원본을 그대로 두고 "건너뜀" 사유와 함께 보고한다(사람이 공식 페이지 캡처로 채운다).
//
// 글 하나의 순서와 되돌리는 법은 reimageKoreaplain.ts 머리말에 있다. 핵심 둘:
//   - **백업이 먼저다.** job.metadata.reimageBackup = { at, images, html, rehostedBySource } - 배포·패치·메타 갱신 전에 저장한다.
//   - **전부 직렬이다.** Pages 배포가 사이트 전체 스냅샷이라 겹치면 앞 글 이미지가 404가 된다(2026-10-15, 2026-10-31).
//
// 사용: npm run koreaplain:reimage -- [--job=<jobId 접두사>] [--limit=N] [--apply]
// 기본은 미리보기다. --apply 없이는 Pages·Blogger·DB·Storage 어디에도 쓰지 않는다(LLM 판정과 Blogger 읽기는 한다).
// 발행 게이트(BLOGGER_ENABLED·TISTORY_PUBLISH_MODE)는 읽지도 바꾸지도 않는다.
// Blogger 자격 증명이 맥 .env에서 거부될 수 있다(2026-10-27) - 그러면 GitHub Actions(수동 실행)에서 돌린다.

import "dotenv/config";

import { loadKoreaplainImagesConfig } from "../../config/koreaplainImages.js";
import { KOREAPLAIN_BLOGGER_BLOG_ID } from "../../config/publishTargets.js";
import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { defaultRehostDeps, rehostImagesToPages } from "../../services/images/rehostImagesToPages.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { listPublicationsByArticleIds } from "../../services/supabase/repositories/publicationRepository.js";
import { supabase } from "../../services/supabase/client.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import { generateReplacementImages, runReimage } from "./reimageKoreaplain.js";
import type { ReimageDeps, ReimageJob } from "./reimageKoreaplain.js";

const USAGE = "사용법: npm run koreaplain:reimage -- [--job=<jobId 접두사>] [--limit=N] [--apply]";
/** 프롬프트·판정 요청 한도. 글 하나의 자리 수십 개를 한 번에 쓰므로 폴백 프롬프트(5분)와 같게 둔다. */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

type Args = { apply: boolean; jobPrefix: string | null; limit: number | null };

function parseArgs(argv: string[]): Args | string {
  const args: Args = { apply: false, jobPrefix: null, limit: null };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--job=")) args.jobPrefix = arg.slice("--job=".length).trim().toLowerCase() || null;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(n) || n <= 0) return `--limit은 1 이상의 정수여야 합니다: ${arg}`;
      args.limit = n;
    } else return `알 수 없는 인자: ${arg}`;
  }
  return args;
}

/** 후보 목록은 metadata 조각만 받는다(Supabase egress) - 전체 행은 글 하나를 고칠 때 mergeMetadata가 읽는다. */
async function listCandidateJobs(): Promise<ReimageJob[]> {
  const columns: string =
    "id,keyword,category,rehostedAt:metadata->>imagesRehostedAt,images:metadata->images,bySource:metadata->rehostedBySource,backupAt:metadata->reimageBackup->>at";
  const { data, error } = await supabase
    .from("article_jobs")
    .select(columns)
    .eq("category", KOREAPLAIN_TRACK)
    .not("metadata->>imagesRehostedAt", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    keyword: String(row.keyword ?? ""),
    category: (row.category as string | null) ?? null,
    imagesRehostedAt: (row.rehostedAt as string | null) ?? null,
    images: Array.isArray(row.images) ? (row.images as ManuscriptImage[]).filter((image) => image && typeof image === "object" && "index" in image) : [],
    rehostedBySource: (row.bySource as Record<string, string> | null) ?? {},
    hasBackup: Boolean(row.backupAt),
  }));
}

/** 이 job의 공개 글 경로. 발행 기록의 URL에서 pathname만 뽑는다(옛 blogspot 주소든 맞춤 도메인이든 같다). */
async function findPostPath(jobId: string): Promise<string | null> {
  const articles = await listArticlesByJobId(jobId);
  const publications = await listPublicationsByArticleIds(articles.map((article) => article.id));
  const published = publications.find((publication) => publication.status === "published" && publication.published_url);
  if (!published?.published_url) return null;
  try {
    return new URL(published.published_url).pathname;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(`${parsed}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const { apply } = parsed;

  // 환경변수 이름은 옛 코드명 그대로다(GitHub 시크릿에 등록된 이름이라 바꾸면 발행이 끊긴다).
  const config = loadKoreaplainImagesConfig();
  if (apply && !config.enabled) {
    console.error("❌ 이미지 호스팅 설정이 비어 있습니다 - KSCENE_IMAGES_PAGES_PROJECT·CLOUDFLARE_* 를 확인하세요");
    process.exitCode = 1;
    return;
  }
  if (!KOREAPLAIN_BLOGGER_BLOG_ID) {
    console.error("❌ KSCENE_BLOGGER_BLOG_ID가 없습니다 - Korea Plain 블로그를 지정할 수 없어 중단합니다");
    process.exitCode = 1;
    return;
  }
  console.log(`▶ ${config.projectName ?? "(Pages 프로젝트 미설정)"}${config.baseUrl ? ` (${config.baseUrl})` : ""}`);
  console.log(apply ? "▶ 실제로 교체합니다(글 하나씩 차례로)\n" : "▶ 미리보기 - 아무것도 쓰지 않습니다(--apply로 실행)\n");

  const blogger = new BloggerClient({ blogId: KOREAPLAIN_BLOGGER_BLOG_ID });
  const rehostDeps = defaultRehostDeps();
  const deps: ReimageDeps = {
    listJobs: listCandidateJobs,
    findPostPath,
    blogger: {
      findPostId: (path) => blogger.getPostIdByPath(path),
      getContent: (postId) => blogger.getPostContent(postId),
      patchContent: (postId, html) => blogger.patchPostContent(postId, html),
    },
    askPrompts: (prompt) => runHeadlessClaude({ prompt, timeoutMs: PROMPT_TIMEOUT_MS, allowedTools: [] }),
    generate: (job, slots) => generateReplacementImages(job, slots),
    rehost: (job, images) => rehostImagesToPages({ jobId: job.id, images, config }, rehostDeps),
    saveMetadata: async (jobId, patch) => {
      await ArticleJobRepository.mergeMetadata(jobId, patch);
    },
    now: () => new Date(),
    log: (line) => console.log(line),
  };

  const summary = await runReimage(deps, { ...parsed });

  console.log(
    `\n${apply ? "교체" : "교체 예정"} ${summary.replaced}장 / 건너뜀 ${summary.skipped}장 / 실패 ${summary.failed}장 (글 ${summary.outcomes.length}건)`
  );
  if (summary.failedJobs.length > 0) {
    console.error(`\n❌ 실패가 있는 글 ${summary.failedJobs.length}건:`);
    for (const outcome of summary.failedJobs) {
      console.error(`  - ${outcome.jobId} (${outcome.keyword})${outcome.jobError ? ` ${outcome.jobError}` : ""}`);
      for (const note of outcome.failed) console.error(`      자리 ${note.index}: ${note.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ 끝났습니다");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
