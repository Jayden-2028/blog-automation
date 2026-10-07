// "📤 수정본 반영" 요청을 적용한다. GitHub Actions(manuscript-edit.yml)가 돌린다.
//
// 사용법:
//   MANUSCRIPT_EDIT_JSON='{"jobId":"...","edits":{...}}' npm run manuscripts:apply-edit
//   npm run manuscripts:apply-edit -- <요청.json>        (손으로 재실행할 때)
//
// **DB에 쓴다**(articles.content, article_jobs.metadata, manuscript_manifest_topics) - 사용자가 뷰어에서
// 버튼을 눌렀을 때만 이 경로가 돈다(2026-10-03 사용자 승인 설계).
import "dotenv/config";

import { readFile } from "node:fs/promises";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId, updateArticle } from "../../services/supabase/repositories/articleRepository.js";
import { loadManifest, saveManifest } from "./manuscriptManifest.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";
import { writeManuscriptPages } from "./writeManuscriptPages.js";
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";
import { writeCostSnapshot } from "../reports/writeCostSnapshot.js";
import { applyViewerEditRequest, parseViewerEditRequest } from "./applyViewerEditRequest.js";

/** buildManuscriptPageCli의 --refresh와 같은 순서: 페이지 -> 비용 스냅샷 -> 배포. */
async function publishPage(manifest: ManuscriptManifest): Promise<void> {
  await writeManuscriptPages(manifest);

  // 배포 단위가 디렉터리 하나라 cost.json을 여기서 써야 함께 올라간다(없으면 배포본에서 사라진다).
  const cost = await writeCostSnapshot();
  if (cost.status === "failed") console.warn(`⚠️ 비용 스냅샷 생성 실패(무시하고 계속): ${cost.error}`);

  const deploy = await deployManuscriptsPage();
  if (deploy.status === "success") console.log(`✅ 배포 완료: ${deploy.url}`);
  else if (deploy.status === "failed") throw new Error(`배포 실패: ${deploy.error}`);
  else console.log(`ℹ️ 배포 건너뜀: ${deploy.reason}`);
}

async function readRequestJson(): Promise<string> {
  const file = process.argv[2];
  if (file) return readFile(file, "utf8");
  const env = process.env.MANUSCRIPT_EDIT_JSON;
  if (!env) throw new Error("MANUSCRIPT_EDIT_JSON 또는 요청 파일 경로가 필요합니다");
  return env;
}

async function main(): Promise<void> {
  const request = parseViewerEditRequest(await readRequestJson());
  console.log(`▶ 뷰어 수정본 반영: job ${request.jobId} · 항목 ${Object.keys(request.edits).length}개`);

  const outcome = await applyViewerEditRequest(request, {
    loadJob: (jobId) => ArticleJobRepository.findById(jobId),
    loadArticles: listArticlesByJobId,
    updateArticleContent: async (articleId, content) => {
      await updateArticle(articleId, { content });
    },
    updateArticleTitle: async (articleId, title) => {
      await updateArticle(articleId, { title });
    },
    mergeJobMetadata: async (jobId, patch) => {
      await ArticleJobRepository.mergeMetadata(jobId, patch);
    },
    loadManifest,
    saveTopic: (topic) => saveManifest({ topics: [topic] }),
    publishPage,
  });

  if (outcome.status === "failed") {
    console.error(`❌ ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `✅ ${outcome.status === "applied" ? "반영" : "반영할 것 없음"} - 반영 ${outcome.record.applied.length}개` +
      ` · 건너뜀 ${outcome.record.skipped.length}개 · 본문 ${outcome.articleChanged ? "갱신" : "그대로"}` +
      ` · 캡션 ${outcome.imagesChanged ? "갱신" : "그대로"} · 제목 ${outcome.titleChanged ? "갱신" : "그대로"}`
  );
  for (const skip of outcome.record.skipped) console.log(`   ⏭ ${skip.key}: ${skip.reason}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
