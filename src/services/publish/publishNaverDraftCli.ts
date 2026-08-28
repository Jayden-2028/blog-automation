// 승인된 원고 1건을 네이버 블로그에 "임시저장"하는 수동 진입점(SPRINT_4_DESIGN.md §7 - 발행
// 트리거는 여전히 사람이 CLI로 직접 실행한다, §9-1 결정: CLI만 먼저).
//
// 실제 상태 갱신/브라우저 조작은 publishArticleToNaver.ts가 한다 - 이 파일은 argv 파싱과
// 사람이 읽을 출력만 담당한다(rejectJobCli.ts와 같은 패턴).
//
// ⚠️ 이 명령은 실제 네이버 계정으로 브라우저를 열어 로그인 세션을 사용한다(headless 기본).
// "임시저장"까지만 하고 "발행"은 하지 않지만, 그래도 사용자의 실제 블로그 초안함에 글이
// 하나 생긴다는 뜻이므로 실행 전 job이 정말 승인됐는지 확인하고 실행한다.
//
// 사용법:
//   npm run job:publish -- <jobId>            # jobId를 알 때(기본 headless)
//   npm run job:publish -- <jobId> --watch    # 브라우저 창을 직접 지켜볼 때(실측 검증용)
//   npm run job:publish                       # jobId 없이 실행하면 approved job 목록을 보여준다
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../supabase/repositories/articleRepository.js";
import { NaverBlogPublisher } from "./NaverBlogPublisher.js";
import { notifyPublishReady } from "./notifyPublishReady.js";
import { publishArticleToNaver } from "./publishArticleToNaver.js";

async function listCandidateJobs(): Promise<void> {
  const approved = await ArticleJobRepository.listByStatus("approved", 20);

  if (approved.length === 0) {
    console.log("현재 발행(임시저장) 가능한 job이 없습니다. Telegram에서 원고를 먼저 승인해주세요.");
    return;
  }

  console.log(`▶ 승인 완료, 임시저장 대기 중인 job ${approved.length}건\n`);
  for (const job of approved) {
    console.log(`  ${job.id}`);
    console.log(`    ${job.keyword} (${job.category ?? "N/A"}, ${job.total_score ?? "?"}점)`);
  }
  console.log(`\n임시저장하려면: npm run job:publish -- <jobId>`);
}

async function main(): Promise<void> {
  const jobId = process.argv[2];

  if (!jobId) {
    await listCandidateJobs();
    return;
  }

  const watch = process.argv.includes("--watch");

  console.log(`▶ 네이버 블로그 임시저장 시작: ${jobId}`);
  console.log("   (실제 발행 버튼은 누르지 않습니다 - 임시저장까지만 자동화합니다)");
  if (watch) console.log("   (--watch: 브라우저 창을 직접 띄워 지켜봅니다)");
  console.log();

  const result = await publishArticleToNaver(
    jobId,
    watch ? { saveDraft: (input) => new NaverBlogPublisher({ headless: false }).saveDraft(input) } : {}
  );

  if (!result.ok) {
    if (result.reason === "job_not_found") {
      console.log(`⏭ job을 찾을 수 없습니다: ${jobId}`);
      return;
    }
    if (result.reason === "job_not_approved") {
      console.log(`⏭ ${result.detail}`);
      return;
    }
    if (result.reason === "article_not_found") {
      console.log(`⏭ ${result.detail}`);
      return;
    }
    console.error(`❌ 네이버 임시저장 실패 [${result.stage} 단계]: ${result.detail}`);
    process.exitCode = 1;
    return;
  }

  if (result.alreadyDone) {
    console.log(`⏭ 이미 임시저장이 완료돼 있습니다 (publication #${result.publicationId})`);
    console.log(`   초안 URL: ${result.draftUrl}`);
    console.log(`   중복 실행을 막기 위해 다시 저장하지 않았습니다.`);
    return;
  }

  console.log(`✅ 임시저장 완료 (publication #${result.publicationId})`);
  console.log(`   초안 URL: ${result.draftUrl}`);
  console.log(`   이미지: ${result.imageCount}장 업로드 시도`);
  console.log(`\n⚠️ 브라우저 창에서 내용을 직접 확인한 뒤, 문제없으면 사람이 직접 '발행' 버튼을 눌러주세요.`);

  // Telegram 알림 - 폰에서 바로 초안을 열어볼 수 있게 버튼을 단다(notifyArticleReady.ts와 같은 이유).
  const job = await ArticleJobRepository.findById(jobId);
  const articles = await listArticlesByJobId(jobId);
  const article = articles[articles.length - 1];
  console.log("\n▶ Telegram 알림 발송 중...");
  await notifyPublishReady({
    keyword: job?.keyword ?? jobId,
    title: article?.title ?? null,
    draftUrl: result.draftUrl,
    imageCount: result.imageCount,
  });
  console.log("✅ 완료 - Telegram에서 확인해주세요");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
