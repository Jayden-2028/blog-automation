// 발행된 사용설명서 이미지가 Pages에 아직 있는지 매일 점검하고, 사라졌으면 텔레그램으로 알린다.
//
// 왜 만들었나(2026-11-03 사용자 요청): 같은 사고가 두 번 났고(10-15·10-31) **두 번 다 사용자가 블로그
// 관리 화면에서 깨진 썸네일을 눈으로 발견했다.** 감지 수단이 사람 눈뿐이면 늦게 발견하는 날이 오고,
// 그러면 `storage-cleanup`이 발행 14일 뒤 Supabase 원본을 지운 뒤라 **되살릴 수 없다**. 판정 기준과
// 문구는 classifyPagesImageHealth.ts에 있다.
//
// **블로그 글을 긁지 않는다.** 발행 HTML이 가리키는 Pages URL은 발행 때 job.metadata.rehostedBySource에
// (원본 URL -> Pages URL) 남아 있으므로 DB에서 바로 읽는다. 사이트맵을 돌며 각 글을 내려받는 방식은
// 2026-11-03에 실제로 막혔다 - 구글이 50여 편에서 302 -> /sorry -> 429로 끊는다.
//
// 사용:
//   npm run images:health                 점검 + 출력(알림 없음)
//   npm run images:health -- --notify     고장이 있을 때만 텔레그램 발송
//   npm run images:health -- --limit=20   최근 20편만
import "dotenv/config";

import { loadKsceneImagesConfig } from "../../config/ksceneImages.js";
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { mapWithConcurrency } from "../../services/mapWithConcurrency.js";
import { supabase } from "../../services/supabase/client.js";
import {
  buildImageHealthMessage,
  buildImageHealthReport,
  shortJobId,
  shouldNotify,
  verdictOf,
} from "./classifyPagesImageHealth.js";
import type { ImageProbe, JobImageProbes } from "./classifyPagesImageHealth.js";

/**
 * 동시에 묻는 개수. 우리 Pages와 Supabase라 남의 rate limit을 걱정할 일은 없지만, 발행본이 늘수록
 * 장수도 늘어 한꺼번에 던지면 소켓만 말린다. 8개면 320장을 1분 안에 본다.
 */
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 15_000;

/** 기본 점검 범위. 발행본 전체를 본다 - 오래된 글이 깨져도 똑같이 깨진 글이다. */
const DEFAULT_LIMIT = 300;

type RehostedJob = { id: string; keyword: string; rehostedAt: string | null; bySource: Record<string, string> };

/**
 * 이미지를 Pages로 옮긴 job. `imagesRehostedAt`이 있어야 전부 옮겨진 것이고(publishArticleToBlogspot.ts),
 * 그 표식이 곧 "발행 HTML이 Pages URL을 가리킨다"는 뜻이다.
 */
async function loadRehostedJobs(limit: number): Promise<RehostedJob[]> {
  const { data, error } = await supabase
    .from("article_jobs")
    .select("id, keyword, rehostedAt:metadata->>imagesRehostedAt, bySource:metadata->rehostedBySource")
    .not("metadata->>imagesRehostedAt", "is", null)
    .order("metadata->>imagesRehostedAt", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as RehostedJob[]).map((row) => ({ ...row, bySource: row.bySource ?? {} }));
}

/**
 * HEAD 한 번. 확인 실패(타임아웃·네트워크)는 한 번만 다시 묻는다 - 404는 다시 물어도 404지만
 * 일시적 실패를 고장으로 보고하면 매일 거짓 경보가 난다.
 */
async function probe(url: string): Promise<ImageProbe> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (verdictOf(response.status) !== "unreachable" || attempt === 1) return { url, status: response.status };
    } catch {
      if (attempt === 1) return { url, status: 0 };
    }
  }
  return { url, status: 0 };
}

async function main(): Promise<void> {
  const notify = process.argv.includes("--notify");
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice("--limit=".length));
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT;

  // enabled면 둘 다 채워져 있지만 타입은 그걸 모른다 - 같이 좁혀 둔다.
  const { projectName, baseUrl, enabled } = loadKsceneImagesConfig();
  if (!enabled || !projectName || !baseUrl) {
    console.error("❌ 이미지 호스팅 설정이 비어 있습니다 - KSCENE_IMAGES_PAGES_PROJECT·CLOUDFLARE_* 를 확인하세요");
    process.exitCode = 1;
    return;
  }

  const jobs = await loadRehostedJobs(limit);
  console.log(`▶ ${projectName} (${baseUrl}) · 발행본 ${jobs.length}편\n`);

  const probes: JobImageProbes[] = [];
  for (const job of jobs) {
    // 지금 보는 Pages 프로젝트의 주소만 점검한다. 프로젝트를 옮긴 적이 있으면 옛 주소가 섞여 있는데,
    // 그 주소는 이 프로젝트의 배포가 덮을 수 없으므로 여기서 판정할 대상이 아니다.
    const pageUrls = Object.values(job.bySource).filter((url) => typeof url === "string" && url.startsWith(baseUrl));
    if (pageUrls.length === 0) continue;

    const pages = await mapWithConcurrency(pageUrls, PROBE_CONCURRENCY, probe);
    const goneSources = Object.entries(job.bySource)
      .filter(([, pageUrl]) => pages.some((p) => p.url === pageUrl && verdictOf(p.status) === "gone"))
      .map(([source]) => source);
    // 사라진 자리만 원본을 묻는다 - 복구 가능한지가 알림의 핵심이고, 멀쩡한 글까지 묻는 건 헛걸음이다.
    const origins = await mapWithConcurrency(goneSources, PROBE_CONCURRENCY, probe);

    const gone = pages.filter((p) => verdictOf(p.status) === "gone").length;
    const unreachable = pages.filter((p) => verdictOf(p.status) === "unreachable").length;
    const mark = gone > 0 ? "🚨" : unreachable > 0 ? "⚠️ " : "✅";
    console.log(
      `${mark} ${shortJobId(job.id)} ${job.keyword.slice(0, 40).padEnd(42)} ${pages.length}장` +
        (gone > 0 ? ` · 사라짐 ${gone}` : "") +
        (unreachable > 0 ? ` · 확인 실패 ${unreachable}` : "")
    );
    probes.push({ jobId: job.id, keyword: job.keyword, pages, origins });
  }

  const report = buildImageHealthReport(probes);
  console.log(
    `\n${report.jobs}편 ${report.images}장 · 사라짐 ${report.goneImages}장(${report.broken.length}편)` +
      (report.unreachable > 0 ? ` · 확인 실패 ${report.unreachable}장` : "")
  );

  const message = buildImageHealthMessage(report, projectName);
  console.log(`\n── 알림 문구 ${"─".repeat(40)}\n${message.replace(/<[^>]+>/g, "")}`);

  // 고장이 있으면 실패로 끝낸다 - 워크플로 실행 목록에서 빨간 줄이 보여야 알림을 놓쳐도 남는다.
  if (report.broken.length > 0) process.exitCode = 1;

  if (!notify) {
    console.log("\n· --notify를 붙이면 고장이 있을 때 텔레그램으로 보냅니다.");
    return;
  }
  if (!shouldNotify(report)) {
    console.log("\n· 고장이 없어 알림을 보내지 않습니다(매일 도는 점검이라 조용할 때는 말하지 않습니다).");
    return;
  }
  // 사용설명서 블로그 이야기라 그 트랙 봇으로 보낸다(telegramTracks.ts).
  await TelegramNotifier.fromEnv("kscene").send(message);
  console.log("\n✅ 텔레그램 발송 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
