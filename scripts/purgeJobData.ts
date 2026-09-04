// 기준일 이전의 원고 job 데이터를 지운다(테스트 잔재 + 과거 작업 정리용).
//
// ⚠️ 원격 DB 삭제는 되돌릴 수 없다. 그래서 **기본이 dry-run**이고, `--confirm`을 명시적으로
// 붙여야만 실제로 지운다(CLAUDE.md "승인 없이는 금지" - 원격 DB delete).
//
// 사용법:
//   npm run purge:jobs                          지울 대상만 출력(아무것도 안 지움)
//   npm run purge:jobs -- --confirm             실제 삭제
//   npm run purge:jobs -- --before 2026-09-01   기준일 지정(기본: 오늘 00:00 KST)
//   npm run purge:jobs -- --confirm --storage   Storage 이미지 파일까지 삭제
//
// 지우는 것(FK 때문에 자식부터):
//   publications -> images -> articles -> sources -> article_jobs
// 지우지 않는 것:
//   discovery_runs / keyword_rankings  (실제 키워드 수집 이력. watchdog이 오늘 run 집계에 쓴다)
//   seed_queries / keywords / trend_candidates  (job 데이터가 아니다)
//
// 이 스크립트로 지울 수 없는 것(사람이 직접):
//   네이버·티스토리 임시저장 글, Blogspot draft, Telegraph 페이지 - 전부 외부 서비스에 있다.
import "dotenv/config";

import { supabase } from "../src/services/supabase/client.js";
import { ARTICLE_IMAGES_BUCKET } from "../src/services/supabase/storage/uploadArticleImage.js";

/** 오늘 00:00 KST를 UTC ISO로. 이 시각 이전에 선택된 job이 삭제 대상이다. */
function todayStartKstIso(): string {
  const nowKst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  return new Date(`${nowKst}T00:00:00+09:00`).toISOString();
}

function parseArgs(): { before: string; confirm: boolean; storage: boolean } {
  const argv = process.argv.slice(2);
  const beforeIndex = argv.indexOf("--before");
  const beforeRaw = beforeIndex >= 0 ? argv[beforeIndex + 1] : undefined;

  let before = todayStartKstIso();
  if (beforeRaw) {
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(beforeRaw) ? `${beforeRaw}T00:00:00+09:00` : beforeRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`--before 값을 날짜로 읽을 수 없습니다: ${beforeRaw}`);
    }
    before = parsed.toISOString();
  }

  return { before, confirm: argv.includes("--confirm"), storage: argv.includes("--storage") };
}

function kst(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

async function main(): Promise<void> {
  const { before, confirm, storage } = parseArgs();

  console.log(`▶ 기준: ${kst(before)} (KST) 이전에 선택된 job`);
  console.log(`▶ 모드: ${confirm ? "🔴 실제 삭제" : "🔍 dry-run (아무것도 지우지 않음)"}\n`);

  // 1) 삭제 대상 job
  const { data: targetJobs, error: jobError } = await supabase
    .from("article_jobs")
    .select("id, keyword, status, selected_at")
    .lt("selected_at", before)
    .order("selected_at", { ascending: true });
  if (jobError) throw jobError;

  const jobIds = (targetJobs ?? []).map((job) => job.id);
  if (jobIds.length === 0) {
    console.log("삭제할 job이 없습니다.");
    return;
  }

  // 2) 딸린 행 수집
  const { data: targetArticles, error: articleError } = await supabase
    .from("articles")
    .select("id, title, platform")
    .in("job_id", jobIds);
  if (articleError) throw articleError;
  const articleIds = (targetArticles ?? []).map((a) => a.id);

  const { count: sourceCount, error: sourceError } = await supabase
    .from("sources")
    .select("id", { count: "exact", head: true })
    .in("job_id", jobIds);
  if (sourceError) throw sourceError;

  let imageCount = 0;
  let publicationCount = 0;
  if (articleIds.length > 0) {
    const { count: images, error: imageError } = await supabase
      .from("images")
      .select("id", { count: "exact", head: true })
      .in("article_id", articleIds);
    if (imageError) throw imageError;
    imageCount = images ?? 0;

    const { count: publications, error: publicationError } = await supabase
      .from("publications")
      .select("id", { count: "exact", head: true })
      .in("article_id", articleIds);
    if (publicationError) throw publicationError;
    publicationCount = publications ?? 0;
  }

  // 3) 대상 요약
  console.log(`삭제 대상`);
  console.log(`  article_jobs   ${jobIds.length}건`);
  console.log(`  articles       ${articleIds.length}건 (배리에이션 포함)`);
  console.log(`  sources        ${sourceCount ?? 0}건`);
  console.log(`  images         ${imageCount}건`);
  console.log(`  publications   ${publicationCount}건\n`);

  console.log("job 목록:");
  for (const job of targetJobs ?? []) {
    console.log(`  ${job.id.slice(0, 8)}… [${job.status}] ${job.keyword} (${kst(job.selected_at)})`);
  }

  // 4) 유지되는 것 안내
  const { count: runCount } = await supabase.from("discovery_runs").select("id", { count: "exact", head: true });
  console.log(`\n유지: discovery_runs ${runCount ?? 0}건 + keyword_rankings (키워드 수집 이력, watchdog가 사용)`);

  if (!confirm) {
    console.log("\n🔍 dry-run이라 아무것도 지우지 않았습니다.");
    console.log("   실제로 지우려면: npm run purge:jobs -- --confirm");
    if (!storage) console.log("   Storage 이미지까지 지우려면 --storage 를 함께 붙이세요.");
    return;
  }

  // 5) 실제 삭제 - FK 때문에 자식부터
  console.log("\n🔴 삭제 시작...");

  if (articleIds.length > 0) {
    const { error } = await supabase.from("publications").delete().in("article_id", articleIds);
    if (error) throw error;
    console.log(`  ✅ publications ${publicationCount}건`);

    const { error: imageDeleteError } = await supabase.from("images").delete().in("article_id", articleIds);
    if (imageDeleteError) throw imageDeleteError;
    console.log(`  ✅ images ${imageCount}건`);
  }

  const { error: articleDeleteError } = await supabase.from("articles").delete().in("job_id", jobIds);
  if (articleDeleteError) throw articleDeleteError;
  console.log(`  ✅ articles ${articleIds.length}건`);

  const { error: sourceDeleteError } = await supabase.from("sources").delete().in("job_id", jobIds);
  if (sourceDeleteError) throw sourceDeleteError;
  console.log(`  ✅ sources ${sourceCount ?? 0}건`);

  const { error: jobDeleteError } = await supabase.from("article_jobs").delete().in("id", jobIds);
  if (jobDeleteError) throw jobDeleteError;
  console.log(`  ✅ article_jobs ${jobIds.length}건`);

  // 6) Storage 이미지(선택) - 경로가 `<jobId>/<n>.png`라 job 단위로 지운다.
  if (storage) {
    let removed = 0;
    for (const jobId of jobIds) {
      const { data: files } = await supabase.storage.from(ARTICLE_IMAGES_BUCKET).list(jobId);
      const paths = (files ?? []).map((file) => `${jobId}/${file.name}`);
      if (paths.length === 0) continue;
      const { error } = await supabase.storage.from(ARTICLE_IMAGES_BUCKET).remove(paths);
      if (error) {
        console.warn(`  ⚠️ Storage 삭제 실패(${jobId}): ${error.message}`);
        continue;
      }
      removed += paths.length;
    }
    console.log(`  ✅ Storage 이미지 파일 ${removed}건`);
  } else {
    console.log("  ⏭ Storage 이미지 파일은 건드리지 않았습니다(--storage 로 함께 삭제 가능).");
  }

  console.log("\n✅ 완료. 남은 정리(사람이 직접):");
  console.log("   - 네이버 블로그 임시저장함의 옛 초안");
  console.log("   - 티스토리 임시저장 글");
  console.log("   - Blogspot draft 글");
  console.log("   - 로컬 파일: research/*.md, drafts/*.md");
}

main().catch((error) => {
  console.error("❌ 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
