// 생성된 이미지를 맥 로컬로 내려받는다 (BLOGSPOT_ONLY_DESIGN.md §3-4).
//
// 왜 필요한가: 파이프라인은 GitHub Actions에서 돌고 이미지는 Supabase Storage에 올라간다.
// 뷰어는 그 공개 URL을 그대로 보여주면 되지만, 사람이 Blogger 편집기에 **올릴 파일**이 필요하다.
// 자동 업로드를 켜면(§5) Blogger가 Storage URL을 그대로 쓰므로 이 단계는 없어진다 - 지금 단계용 다리다.
//
// 이미 있는 파일은 건너뛴다(같은 이름 = 같은 이미지). --force로 다시 받는다.
//
// 실행: npm run sync:images            (manifest 전체, 최근 날짜부터)
//       npm run sync:images -- <jobId> (그 원고만)
//       npm run sync:images -- --force

import "dotenv/config";
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

import { loadManifest } from "../manuscripts/manuscriptManifest.js";
import { manuscriptImageDir } from "../../config/pipelinePaths.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const jobId = args.find((a) => !a.startsWith("--")) ?? null;

  const manifest = await loadManifest();
  const topics = jobId ? manifest.topics.filter((t) => t.jobId === jobId) : manifest.topics;

  if (topics.length === 0) {
    console.log(jobId ? `해당 job의 원고가 manifest에 없습니다: ${jobId}` : "manifest에 원고가 없습니다.");
    return;
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const topic of topics) {
    const images = topic.manuscript.images.filter((i) => i.url);
    if (images.length === 0) continue;

    const dir = manuscriptImageDir(topic.date, topic.keyword);
    await mkdir(dir, { recursive: true });

    for (const image of images) {
      const target = resolve(dir, image.fileName);
      if (!force && (await exists(target))) {
        skipped += 1;
        continue;
      }
      try {
        const response = await fetch(image.url as string);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        downloaded += 1;
        console.log(`⬇️  ${topic.keyword} / ${image.fileName}`);
      } catch (error) {
        failed += 1;
        console.error(`⚠️  ${topic.keyword} / ${image.fileName}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  console.log(`\n✅ 내려받음 ${downloaded}장 · 건너뜀 ${skipped}장${failed > 0 ? ` · 실패 ${failed}장` : ""}`);
  if (downloaded === 0 && skipped === 0) {
    console.log("아직 생성된 이미지가 없습니다 - MANUSCRIPT_IMAGE_GENERATION=true와 이미지 API 키를 확인하세요.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
