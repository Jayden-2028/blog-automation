// 뷰어 "후보 이미지 클릭 교체" 요청을 적용한다. GitHub Actions(image-pick.yml)가 돌린다.
//
// 사용법:
//   IMAGE_PICK_JSON='{"jobId":"...","index":2,"candidateNumber":3,"fromUrl":"..."}' npm run manuscripts:image-pick
//   npm run manuscripts:image-pick -- <요청.json>        (손으로 재실행할 때)
//
// **DB(job.metadata, manuscript_manifest_topics)와 Storage에 쓴다** - 사용자가 뷰어에서 후보를 눌렀을 때만 돈다.
// 원고 준비 재실행·준비 완료 알림 재발송은 하지 않는다(그 슬롯만 바꾼다). 끝나면 그 트랙 봇으로 결과를 한 통 알린다
// (2026-11-05, 뷰어 링크 버튼 포함). 순수 로직은 applyImagePick.ts.
import "dotenv/config";

import { readFile } from "node:fs/promises";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { listPublicationsByArticleIds } from "../../services/supabase/repositories/publicationRepository.js";
import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramReplyMarkup } from "../../notifications/TelegramNotifier.js";
import { trackOfJob } from "../../notifications/telegramTracks.js";
import { defaultFetchImage } from "../images/collectWebImages.js";
import { loadManifest, saveManifest } from "./manuscriptManifest.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";
import { readImageSize } from "./exportManuscript.js";
import { writeManuscriptPages } from "./writeManuscriptPages.js";
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";
import { writeCostSnapshot } from "../reports/writeCostSnapshot.js";
import { applyImagePick, parseImagePickRequest } from "./applyImagePick.js";
import { cloudflarePagesUrl } from "../../config/manuscriptsPageTargets.js";
import { viewerPageLink } from "../../config/manuscriptViewerPages.js";

/** applyViewerEditCli와 같은 순서: 페이지 -> 비용 스냅샷 -> 배포. */
async function publishPage(manifest: ManuscriptManifest): Promise<void> {
  await writeManuscriptPages(manifest);
  const cost = await writeCostSnapshot();
  if (cost.status === "failed") console.warn(`⚠️ 비용 스냅샷 생성 실패(무시하고 계속): ${cost.error}`);

  const deploy = await deployManuscriptsPage();
  if (deploy.status === "success") console.log(`✅ 배포 완료: ${deploy.url}`);
  else if (deploy.status === "failed") throw new Error(`배포 실패: ${deploy.error}`);
  else console.log(`ℹ️ 배포 건너뜀: ${deploy.reason}`);
}

/**
 * 알림에 붙이는 "원고 페이지 열기" 버튼. 주소 규칙은 준비 완료 알림(buildReadyKeyboard)과 같다 - 엔터는 해시,
 * 나머지 트랙은 트랙별 페이지다. Pages 주소가 설정돼 있지 않으면 버튼 없이 글만 보낸다.
 *
 * 왜 버튼을 붙이나(2026-11-05): 교체 알림을 받는 이유가 "가서 확인하는 것"이라, 알림에서 한 번에 열리지 않으면
 * 뷰어를 다시 찾아 들어가야 한다.
 */
function viewerKeyboard(job: ArticleJobRow): TelegramReplyMarkup | undefined {
  const pagesUrl = cloudflarePagesUrl();
  if (!pagesUrl) return undefined;
  const track = trackOfJob(job);
  const url = track === "entertainment" ? `${pagesUrl}/#${job.id}` : viewerPageLink(pagesUrl, track, job.id);
  return { inline_keyboard: [[{ text: "📄 원고 페이지 열기", url }]] };
}

async function readRequestJson(): Promise<string> {
  const file = process.argv[2];
  if (file) return readFile(file, "utf8");
  const env = process.env.IMAGE_PICK_JSON;
  if (!env) throw new Error("IMAGE_PICK_JSON 또는 요청 파일 경로가 필요합니다");
  return env;
}

async function main(): Promise<void> {
  const request = parseImagePickRequest(await readRequestJson());
  console.log(`▶ 후보 이미지 교체: job ${request.jobId} · ${request.index}번 자리 ← 후보 ${request.candidateNumber}`);

  const outcome = await applyImagePick(request, {
    loadJob: (jobId) => ArticleJobRepository.findById(jobId),
    loadManifest,
    fetchImage: ({ url, referer }) => defaultFetchImage({ url, referer }),
    readSize: readImageSize,
    // Chromium·Claude가 필요한 경로라 긴 세로 이미지일 때만 불러온다.
    cropTall: async (input) => {
      const { cropTallImageWithFocus } = await import("../images/cropTallImage.js");
      return cropTallImageWithFocus({ ...input, filePath: await writeTemp(input.buffer) });
    },
    upload: async ({ jobId, index, buffer, mimeType }) => {
      const uploaded = await uploadArticleImage({ jobId, index, variant: "web", imageBuffer: buffer, mimeType, optimize: true });
      return uploaded.ok
        ? { ok: true as const, url: uploaded.url, extension: uploaded.extension }
        : { ok: false as const, error: uploaded.error };
    },
    mergeJobMetadata: async (jobId, patch) => {
      await ArticleJobRepository.mergeMetadata(jobId, patch);
    },
    saveTopic: (topic) => saveManifest({ topics: [topic] }),
    publishPage,
    isPublished: async (job) => {
      const articles = await listArticlesByJobId(job.id);
      if (articles.length === 0) return false;
      const publications = await listPublicationsByArticleIds(articles.map((a) => a.id));
      return publications.some((p) => p.status === "published");
    },
    notify: async (job, text) => {
      await TelegramNotifier.fromEnv(trackOfJob(job)).sendMessages([{ text, replyMarkup: viewerKeyboard(job) }]);
    },
  });

  if (outcome.status === "failed") {
    console.error(`❌ ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 교체 완료 - ${request.index}번 ← 후보 ${request.candidateNumber}${outcome.record.alreadyPublished ? " (이미 발행된 글 - 발행본 미반영)" : ""}`);
}

async function writeTemp(buffer: Buffer): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const dir = await mkdtemp(resolve(tmpdir(), "image-pick-"));
  const filePath = resolve(dir, "candidate");
  await writeFile(filePath, buffer);
  return filePath;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
