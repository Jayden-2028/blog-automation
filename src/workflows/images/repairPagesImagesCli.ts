// 사용설명서(kscene) 발행 이미지가 Pages에서 사라졌을 때 Supabase 원본으로 되살린다.
//
// 왜 되살아나는가: Pages 경로가 내용 해시(`<jobId8>/<index>-<sha8>.<ext>`)라 **같은 바이트면 같은 경로**가 나온다.
// 그래서 재배포만 하면 발행본(Blogger)이 가리키는 URL이 그대로 살아난다 - **본문은 건드리지 않는다.**
// 조건은 하나, Supabase 원본이 남아 있어야 한다(`storage-cleanup`이 지우기 전에 발견해야 한다).
//
// 왜 사라지는가: 배포가 사이트 전체 스냅샷이라 동시 발행이 겹치면 늦게 배포한 쪽이 앞 글의 파일을 못 본 채 덮는다
// (`services/images/rehostImagesToPages.ts` 머리말). 2026-10-15에 이어 2026-10-31에도 터졌다 - 그때는 세 건이
// 5초 안에 발행돼 먼저 끝난 두 건이 희생됐다.
//
// 사용: npm run images:repair-pages -- <jobId 접두사...> [--project=<Pages 프로젝트>] [--apply]
// 기본은 미리보기다. --apply 없이는 배포하지 않는다.

import "dotenv/config";

import { loadKsceneImagesConfig } from "../../config/ksceneImages.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { defaultRehostDeps, rehostImagesToPages } from "../../services/images/rehostImagesToPages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

async function headStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return response.status;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const projectArg = args.find((a) => a.startsWith("--project="))?.slice("--project=".length).trim();
  const ids = args.filter((a) => !a.startsWith("--"));

  if (ids.length === 0) {
    console.error("사용법: npm run images:repair-pages -- <jobId...> [--project=<Pages 프로젝트>] [--apply]");
    process.exitCode = 1;
    return;
  }

  const config = loadKsceneImagesConfig(projectArg ? { ...process.env, KSCENE_IMAGES_PAGES_PROJECT: projectArg } : process.env);
  if (!config.enabled) {
    console.error("❌ 이미지 호스팅 설정이 비어 있습니다 - KSCENE_IMAGES_PAGES_PROJECT·CLOUDFLARE_* 를 확인하세요");
    process.exitCode = 1;
    return;
  }
  console.log(`▶ ${config.projectName} (${config.baseUrl})`);
  console.log(apply ? "▶ 실제로 재배포합니다\n" : "▶ 미리보기 - 배포하지 않습니다(--apply로 실행)\n");

  let failed = 0;
  // 순차로 돈다. 동시에 돌리면 복구가 바로 그 경합을 다시 일으킨다.
  for (const id of ids) {
    const job = await ArticleJobRepository.findById(id);
    if (!job) {
      console.error(`❌ ${id}: job을 찾지 못했습니다`);
      failed += 1;
      continue;
    }
    const images = ((job.metadata as { images?: ManuscriptImage[] } | null)?.images ?? []).filter((image) => image.url);
    console.log(`── ${job.id} (${job.keyword}) 이미지 ${images.length}장`);
    if (images.length === 0) continue;

    // metadata.images는 Supabase 원본 URL을 들고 있다(치환은 발행 HTML에서만 일어난다).
    const origins = await Promise.all(images.map((image) => headStatus(image.url as string)));
    const gone = images.filter((_, i) => origins[i] !== 200);
    if (gone.length > 0) {
      console.error(`   ❌ Supabase 원본 ${gone.length}장이 없습니다 - 이 글은 재배포로 되살릴 수 없습니다`);
      failed += 1;
      continue;
    }

    if (!apply) {
      console.log("   원본 전부 살아 있습니다 - --apply로 재배포하면 같은 URL로 돌아옵니다");
      continue;
    }

    const result = await rehostImagesToPages({ jobId: job.id, images, config }, defaultRehostDeps());
    for (const failure of result.failures) console.error(`   ⚠️ ${failure}`);
    const statuses = await Promise.all(result.images.map((image) => headStatus(image.url as string)));
    const broken = statuses.filter((status) => status !== 200).length;
    console.log(`   재배포 ${result.rehosted}장 / 서비스 확인 ${statuses.length - broken}장 정상${broken > 0 ? ` · ${broken}장 실패` : ""}`);
    if (broken > 0 || !result.complete) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed}건이 남았습니다`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ 끝났습니다");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
