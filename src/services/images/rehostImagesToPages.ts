// 발행 이미지를 공개 Cloudflare Pages 프로젝트로 복사한다(개편3 §4.3-4). 설정은 config/koreaplainImages.ts 머리말.
//
// ⚠️ **Pages 배포는 사이트 전체의 스냅샷이다** - 오늘 이미지만 담아 배포하면 어제까지의 이미지가 사라진다. 그래서:
//   1) 사이트에 둔 `manifest.json`(파일 목록)을 읽어 이전 파일을 전부 내려받아 스테이징 디렉터리를 **재구성**하고
//   2) 거기에 새 파일을 더한 뒤 한 번에 배포한다(wrangler가 내용 해시로 이미 올라간 파일은 다시 올리지 않는다).
// 이전 파일을 하나라도 못 받으면 **배포하지 않는다**(부분 배포는 기존 글의 이미지를 지운다) - 실패로 돌려주고 호출자가
// Supabase URL로 발행한다.
//
// 파일 경로에 내용 해시를 넣는다(`<jobId8>/<index>-<sha8>.<ext>`) - 같은 자리의 이미지를 바꾸면 URL이 달라져 CDN 캐시를
// 신경 쓸 필요가 없고(`_headers`로 immutable 캐시), 같은 이미지를 다시 발행해도 같은 경로라 멱등하다.
//
// ⚠️ **동시 발행 경합은 2026-10-15에 실제로 터졌다**(알려진 한계로 적어 두고 락을 두지 않았던 바로 그것).
// 결혼식 하객 예절(10-12 15:03:43 UTC)과 팁 문화(10-14 15:17:06) 두 글의 이미지가 **전부 404**가 됐다 - 각각 8초·39초
// 뒤에 시작한 다음 발행이 **그 글의 파일이 아직 없는 manifest**로 스냅샷을 재구성해 덮어썼다. 두 번 다 먼저 배포한
// 쪽이 희생됐다. 초기(10-09)에는 7건을 2분 안에 연달아 발행해도 멀쩡했는데, 사이트 파일이 늘어 재구성(기존 전량
// 내려받기)이 길어지면서 배포 구간이 겹치기 시작한 것이다 - **글이 쌓일수록 재발 확률이 올라간다.**
// 그래서 두 겹으로 막는다(2026-10-15 사용자 승인):
//   1) **락**: 배포 전에 이 프로젝트에 진행 중인 배포가 없을 때까지 기다린다(Cloudflare 배포 목록 API).
//      GitHub Actions 러너는 매번 다른 기계라 파일 락(heavyPipelineLock)은 쓸 수 없고, 다투는 자원이 Pages
//      프로젝트 자체이므로 그 자원을 직접 본다 - 사람이 손으로 배포한 것까지 같이 막힌다.
//   2) **사후 검증**: 배포한 뒤 manifest를 다시 읽어 내 파일이 들어갔는지 확인하고, 사라졌으면 재구성부터 다시 한다.
//      락을 잡기 직전에 다른 배포가 시작되는 틈(API 반영 지연)이 남으므로 이 그물이 필요하다.
// **그런데 2026-10-31에 또 터졌다** - 사용설명서 세 건을 5초 안에 발행하자 셋 다 "진행 중 0건"을 보고 함께 출발했다.
// 락은 **먼저 출발한 배포**만 막지 같은 순간에 출발한 배포는 막지 못하고, 사후 검증은 그 시점의 사진일 뿐이라
// 먼저 끝난 두 건은 검증을 통과한 **뒤에** 마지막 배포에 덮였다(이미지 12장 404, 11-03 복구).
// 그래서 사후 검증을 **진행 중인 배포가 다 빠진 뒤로** 미뤘다.
// **그런데 2026-11-12에 또 터졌다 - 그 드레인으로는 애초에 막을 수 없는 구간이 있었다.** 그날 세 편이
// 15초·13초 간격으로 발행됐는데 Cloudflare 배포는 **1.3~1.8초**만 걸렸다(API 실측: 02:22:59.9→02:23:01.5,
// 02:23:15.2→02:23:16.5, 02:23:23.8→02:23:25.6). 정작 다투는 구간은 **목록 읽기 → 기존 전량 내려받기 →
// 배포 생성**의 15~25초인데 이 구간은 배포 목록 API에 아무 흔적이 없다. 그래서 세 run 모두 락·드레인을
// 즉시 통과했고(대기 로그 0줄) 가운데 글만 이미지 7장 전부 404가 됐다 - 마지막 글이 **가운데 글의 배포
// 전에 읽은 목록**으로 스냅샷을 만들어 올렸기 때문이다(가장 이른 것과 가장 늦은 것이 살아남은 이유).
// "진행 중인 배포 0건"은 "지금 아무도 스냅샷을 만들고 있지 않다"는 뜻이 아니다. 그래서 세 겹을 더한다:
//   3) **락을 Cloudflare 밖에 둔다**(`pagesDeployLock.ts` - Supabase 단일 행 뮤텍스). 목록 읽기부터
//      검증까지를 통째로 감싸므로 러너가 몇 대든 스냅샷을 한 번에 하나만 만든다. 테이블이 적용되기
//      전에는 효력이 없어 아래 두 그물이 받는다.
//   4) **배포 직전에 목록을 다시 읽는다**. 내가 재구성하는 동안 끝난 배포의 파일은 내 스냅샷에 없으므로
//      그대로 올리면 **내가 그 글을 죽인다**(그날 가운데 글). 늘어난 파일이 보이면 배포하지 않고
//      재구성부터 다시 한다.
//   5) **검증을 통과한 뒤에도 잠시 더 지켜본다**. 검증은 그 시점의 사진일 뿐이고, 그 순간 다른 발행이
//      목록을 이미 읽고 아직 올리지 않았을 수 있다(그 구간은 보이지 않는다). 그 사이에 덮이면 재배포한다.
// 그래도 깨지면 `npm run images:repair-pages -- <jobId>`로 되살린다(같은 URL).
// manifest는 **캐시를 우회해서** 읽는다 - `_headers`의 `/*` 영구 캐시가 manifest.json에도 걸려 있어서(실측:
// `cache-control: max-age=31536000, immutable`) 캐시된 옛 목록을 읽으면 경합 없이도 같은 사고가 난다.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readImageSize } from "./imageDimensions.js";
import { LOCK_WAIT_MS } from "./pagesDeployLock.js";
import { KSCENE_IMAGES_FILE_LIMIT_WARN } from "../../config/koreaplainImages.js";
import type { KoreaplainImagesConfig } from "../../config/koreaplainImages.js";
import type { ManuscriptImage } from "../../workflows/manuscripts/manuscriptManifest.js";

export type FetchedBytes = { bytes: Uint8Array; contentType: string | null };

export type RehostDeps = {
  /** URL의 바이트를 받는다. 실패는 던진다. 404는 `null`(manifest 최초 부재 구분용). */
  fetchBytes: (url: string) => Promise<FetchedBytes | null>;
  /** Pages 프로젝트의 배포 횟수(미배포 프로젝트 판별용). 실패는 던진다. */
  countDeployments: (config: KoreaplainImagesConfig) => Promise<number>;
  /**
   * 지금 **진행 중인** 배포 수(락). 0이면 배포해도 안전하다. 실패는 던진다 - 호출자가 "확인 불가"로
   * 보고 그냥 진행한다(락을 못 잡아 발행을 막는 것보다 사후 검증에 맡기는 쪽이 낫다).
   */
  countActiveDeployments: (config: KoreaplainImagesConfig) => Promise<number>;
  /** `wrangler pages deploy <dir> ...` 실행. */
  runWrangler: (args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  /** 새 URL이 실제로 서비스되는지 확인한다(배포 직후 전파 대기). */
  isLive: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** 스테이징 디렉터리 생성/정리. */
  makeStagingDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  /**
   * 같은 Pages 프로젝트에 배포하는 다른 발행과 겹치지 않게 잡는 뮤텍스(목록 읽기~검증 전체를 감싼다).
   * null이면 락 없이 진행한다 - 발행을 막는 것보다(버튼이 먹지 않는다) 아래 두 그물에 맡기는 쪽이 낫다.
   */
  acquireProjectLock: (input: { jobId: string; config: KoreaplainImagesConfig }) => Promise<{ release: () => Promise<void> } | null>;
};

export type RehostResult = {
  /** url이 Pages 주소로 바뀐 이미지 목록(실패하면 원본 그대로). */
  images: ManuscriptImage[];
  /** 이번 호출에서 Pages로 옮겨진(또는 이미 옮겨져 있던) 자리 수. */
  rehosted: number;
  /** 모든 대상 이미지가 Pages 주소가 됐는가. true일 때만 호출자가 imagesRehostedAt을 기록한다. */
  complete: boolean;
  deployed: boolean;
  failures: string[];
};

const MANIFEST_PATH = "manifest.json";
const HEADERS_FILE = "_headers";
// 이미지 검색 노출이 블로그 유입에 도움이 되므로 noindex는 걸지 않는다. 경로에 해시가 있어 영구 캐시해도 안전하다.
// **manifest.json만 예외다** - 파일 목록은 매 배포마다 바뀌므로 영구 캐시되면 다음 발행이 옛 목록으로
// 스냅샷을 재구성해 기존 이미지를 지운다(2026-10-15).
const HEADERS_BODY =
  "/*\n  Cache-Control: public, max-age=31536000, immutable\n" + `/${MANIFEST_PATH}\n  Cache-Control: no-store\n`;
const DOWNLOAD_CONCURRENCY = 8;
const LIVE_CHECK_ATTEMPTS = 12;
const LIVE_CHECK_INTERVAL_MS = 5_000;
/** 진행 중인 다른 배포를 기다리는 상한. 넘기면 포기하고 진행한다(사후 검증이 받는다). */
const LOCK_WAIT_ATTEMPTS = 60;
const LOCK_WAIT_INTERVAL_MS = 5_000;
/** 덮어쓰기를 감지했을 때 재구성·재배포를 다시 시도하는 횟수. */
const CLOBBER_ATTEMPTS = 3;
/** 배포 직전 재확인에서 "다른 배포가 끼어들었다"를 보고 재구성부터 다시 하는 횟수(배포는 하지 않았다). */
const RESTART_ATTEMPTS = 3;
/** 검증용 목록 읽기 재시도 - 못 읽은 것을 "이상 없음"으로 넘기면 덮인 줄 모르고 성공으로 끝난다. */
const VERIFY_READ_ATTEMPTS = 3;
const VERIFY_READ_INTERVAL_MS = 3_000;
/**
 * 검증을 통과한 뒤 더 지켜보는 횟수·간격. 다른 발행이 목록을 읽고 배포를 만들기까지가 이 창보다
 * 짧아야 잡힌다 - 실측 2~4초(목록 쓰기 + wrangler 업로드)라 15초면 넉넉하다.
 */
const SETTLE_ATTEMPTS = 5;
const SETTLE_INTERVAL_MS = 3_000;

type SiteManifest = { version: 1; files: Record<string, { bytes: number }> };

function extensionFor(contentType: string | null, url: string): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const byType: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/avif": "avif" };
  if (byType[type]) return byType[type];
  const fromUrl = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return fromUrl === "jpeg" ? "jpg" : fromUrl && ["webp", "png", "jpg", "gif", "avif"].includes(fromUrl) ? fromUrl : "jpg";
}

export function pagesImagePath(jobId: string, index: number, bytes: Uint8Array, ext: string): string {
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return `${jobId.replace(/-/g, "").slice(0, 8)}/${index}-${sha}.${ext}`;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function rehostImagesToPages(
  input: { jobId: string; images: readonly ManuscriptImage[]; config: KoreaplainImagesConfig },
  deps: RehostDeps
): Promise<RehostResult> {
  const { jobId, images, config } = input;
  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  const passthrough = (failures: string[]): RehostResult => ({ images: [...images], rehosted: 0, complete: false, deployed: false, failures });

  if (!config.enabled || !baseUrl || !config.projectName) return passthrough(["이미지 호스팅 미설정(KSCENE_IMAGES_PAGES_PROJECT) - Supabase URL로 발행합니다"]);

  const isOurs = (url: string | null): boolean => Boolean(url && url.startsWith(`${baseUrl}/`));
  const targets = images.filter((image) => image.url && !isOurs(image.url));
  const alreadyDone = images.filter((image) => isOurs(image.url)).length;
  if (targets.length === 0) {
    return { images: [...images], rehosted: alreadyDone, complete: images.every((image) => !image.url || isOurs(image.url)), deployed: false, failures: [] };
  }

  // 1) 원본 이미지를 받는다. 하나라도 못 받으면 그 자리는 Supabase URL로 둔다(전체 중단은 아니다 - 받은 것만 옮긴다).
  const failures: string[] = [];
  const downloaded = new Map<number, { bytes: Uint8Array; path: string; size: { width: number; height: number } | null }>();
  await mapLimit(targets, 4, async (image) => {
    try {
      const fetched = await deps.fetchBytes(image.url as string);
      if (!fetched || fetched.bytes.length === 0) throw new Error("빈 응답");
      const ext = extensionFor(fetched.contentType, image.url as string);
      // 여기 바이트가 실제로 서비스되는 바이트다 - 치수를 읽어 발행 HTML의 `<img width height>`에 쓴다
      // (2026-11-08, CLS). 못 읽으면 null이고 그 자리에는 속성을 붙이지 않는다.
      downloaded.set(image.index, {
        bytes: fetched.bytes,
        path: pagesImagePath(jobId, image.index, fetched.bytes, ext),
        size: readImageSize(Buffer.from(fetched.bytes)),
      });
    } catch (error) {
      failures.push(`[이미지 ${image.index}] 원본을 받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (downloaded.size === 0) return passthrough(failures);

  const newPaths = new Set([...downloaded.values()].map((entry) => entry.path));
  const readManifest = async (): Promise<SiteManifest | null> =>
    // 캐시를 우회한다 - `/*` 영구 캐시가 manifest.json에도 걸려 있어 옛 목록을 읽으면 기존 이미지를 지운다.
    deps
      .fetchBytes(`${baseUrl}/${MANIFEST_PATH}?at=${Date.now()}`)
      .then((response) => (response ? (JSON.parse(Buffer.from(response.bytes).toString("utf8")) as SiteManifest) : null));

  // **스냅샷을 만드는 동안 다른 발행이 끼어들지 못하게 잡는다**(2026-11-12). Cloudflare 배포 목록으로는
  // 이 구간이 보이지 않으므로(배포는 1.5초, 재구성은 15~25초) 락은 Supabase에 있다. 못 잡아도 발행은
  // 진행한다 - 아래 두 그물(배포 직전 재확인·검증 후 지켜보기)이 받는다.
  const lock = await deps.acquireProjectLock({ jobId, config }).catch((error) => {
    console.warn(`⚠️ [rehost] 배포 락 처리 중 오류(락 없이 진행): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  try {
    return await runDeployRounds(
      { jobId, images, config, baseUrl, projectName: config.projectName, downloaded, newPaths, alreadyDone, failures, isOurs, readManifest },
      deps
    );
  } finally {
    await lock?.release().catch((error) =>
      console.warn(`⚠️ [rehost] 배포 락 해제 실패(리스 만료 뒤 자동 회수): ${error instanceof Error ? error.message : String(error)}`)
    );
  }
}

/** 락을 쥔 채로 도는 재구성 -> 배포 -> 검증 루프. 덮였으면 다시, 배포 직전에 끼어든 것이 보이면 재구성부터. */
async function runDeployRounds(input: RoundInput, deps: RehostDeps): Promise<RehostResult> {
  const { config, images, failures } = input;
  const passthrough = (): RehostResult => ({ images: [...images], rehosted: 0, complete: false, deployed: false, failures });

  // 진행 중인 배포가 있으면 기다린다(락 밖에서 사람이 손으로 배포한 경우까지 본다).
  await waitForDeploymentsToDrain(config, deps, (active) =>
    console.log(`⏳ [rehost] 같은 프로젝트에 배포 ${active}건이 진행 중입니다 - 끝나기를 기다립니다`)
  );

  let round = 1;
  let restarts = 0;
  while (round <= CLOBBER_ATTEMPTS) {
    const outcome = await deployRound(input, deps);
    if (outcome.kind === "done") return outcome.result;

    if (outcome.kind === "restart") {
      // 재구성하는 동안 다른 발행이 배포를 끝냈다. 이대로 올리면 그 파일을 내가 지운다 - 배포하지 않았다.
      restarts += 1;
      console.warn(
        `⚠️ [rehost] 재구성 중에 다른 배포가 끝났습니다(내 스냅샷에 없는 파일 ${outcome.added.length}개) - ` +
          `배포하지 않고 ${restarts}/${RESTART_ATTEMPTS}회차 재구성부터 다시 합니다: ${outcome.added.slice(0, 3).join(", ")}`
      );
      if (restarts >= RESTART_ATTEMPTS) {
        failures.push(`다른 발행과 ${RESTART_ATTEMPTS}번 연속 겹쳐 배포하지 못했습니다 - Supabase URL로 발행합니다`);
        return passthrough();
      }
      await waitForDeploymentsToDrain(config, deps);
      continue;
    }

    // 배포한 뒤 내 파일이 사라졌다. 그 배포가 끝나길 기다린 뒤 재구성부터 다시 한다.
    console.warn(`⚠️ [rehost] 배포한 파일이 사라졌습니다(동시 배포에 덮였습니다) - ${round}/${CLOBBER_ATTEMPTS}회차, 다시 시도합니다: ${outcome.missing.join(", ")}`);
    if (round === CLOBBER_ATTEMPTS) {
      failures.push(`동시 배포에 ${CLOBBER_ATTEMPTS}번 연속 덮였습니다(${outcome.missing.join(", ")}) - Supabase URL로 발행합니다`);
      return passthrough();
    }
    round += 1;
    await waitForDeploymentsToDrain(config, deps);
  }
  return passthrough();
}

/**
 * 이 프로젝트에 진행 중인 배포가 없어질 때까지 기다린다. 상한을 넘기면 그냥 진행한다 - 락을 못 잡아
 * 발행을 막는 것보다 사후 검증에 맡기는 쪽이 낫다. 확인 자체가 실패해도 같다(0건으로 본다).
 */
async function waitForDeploymentsToDrain(
  config: KoreaplainImagesConfig,
  deps: RehostDeps,
  onWait?: (active: number) => void
): Promise<void> {
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
    const active = await deps.countActiveDeployments(config).catch(() => 0);
    if (active === 0) return;
    if (attempt === 0) onWait?.(active);
    await deps.sleep(LOCK_WAIT_INTERVAL_MS);
  }
}

type Verdict = { kind: "ok" } | { kind: "clobbered"; missing: string[] } | { kind: "unknown"; detail: string };

/**
 * 배포한 내 파일이 **지금 사이트의** 목록에 있는지 확인하고, 통과한 뒤에도 잠시 더 지켜본다.
 *
 * 왜 한 번 보고 끝내면 안 되는가(2026-11-12): 검증은 그 시점의 사진일 뿐이다. 그 순간 다른 발행이
 * 내 배포 전에 읽은 목록으로 스냅샷을 만들고 있을 수 있고, 그 구간은 배포 목록 API에 보이지 않으므로
 * 드레인이 통과한다. 그 발행이 몇 초 뒤 올리면 내 파일이 사라진다 - 그래서 짧게 더 본다.
 *
 * 왜 "못 읽음"을 통과로 보지 않는가: 그날 세 job 모두 경고 한 줄 없이 끝났다. 확인하지 못한 것은
 * 이상 없음이 아니다.
 */
async function verifyDeployedFiles(
  newPaths: Set<string>,
  readManifest: () => Promise<SiteManifest | null>,
  deps: RehostDeps
): Promise<Verdict> {
  const missingIn = (manifest: SiteManifest | null): string[] =>
    manifest ? [...newPaths].filter((path) => !manifest.files?.[path]) : [...newPaths];

  let detail = "목록을 읽지 못했습니다";
  let confirmed = false;
  for (let attempt = 0; attempt < VERIFY_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.sleep(VERIFY_READ_INTERVAL_MS);
    let current: SiteManifest | null;
    try {
      current = await readManifest();
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      continue;
    }
    const missing = missingIn(current);
    if (missing.length > 0) return { kind: "clobbered", missing };
    confirmed = true;
    break;
  }
  if (!confirmed) return { kind: "unknown", detail };

  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    await deps.sleep(SETTLE_INTERVAL_MS);
    // 지켜보는 중의 읽기 실패는 넘긴다 - 이미 한 번 확인했고, 읽기 실패 자체가 덮임의 근거는 아니다.
    const current = await readManifest().catch(() => undefined);
    if (current === undefined) continue;
    const missing = missingIn(current);
    if (missing.length > 0) return { kind: "clobbered", missing };
  }
  return { kind: "ok" };
}

type RoundInput = {
  jobId: string;
  images: readonly ManuscriptImage[];
  config: KoreaplainImagesConfig;
  baseUrl: string;
  projectName: string;
  downloaded: Map<number, { bytes: Uint8Array; path: string; size: { width: number; height: number } | null }>;
  newPaths: Set<string>;
  alreadyDone: number;
  failures: string[];
  isOurs: (url: string | null) => boolean;
  readManifest: () => Promise<SiteManifest | null>;
};

type RoundOutcome =
  | { kind: "done"; result: RehostResult }
  | { kind: "clobbered"; missing: string[] }
  /** 배포 직전 재확인에서 다른 배포가 끼어든 것이 보였다 - **배포하지 않았다**. 재구성부터 다시 한다. */
  | { kind: "restart"; added: string[] };

/** 재구성 -> 배포 -> 서비스 확인 -> 사후 검증 한 바퀴. 덮인 것이 확인되면 "clobbered"로 돌려준다. */
async function deployRound(input: RoundInput, deps: RehostDeps): Promise<RoundOutcome> {
  const { jobId, images, config, baseUrl, projectName, downloaded, newPaths, alreadyDone, failures, isOurs, readManifest } = input;
  const passthrough = (): RehostResult => ({ images: [...images], rehosted: 0, complete: false, deployed: false, failures });
  void jobId;

  const stagingDir = await deps.makeStagingDir();
  try {
    // 2) 이전 스냅샷 재구성: manifest.json을 읽고 그 파일을 전부 내려받는다.
    //    새로 만든 Pages 프로젝트는 첫 배포 전까지 404가 아니라 522를 돌려준다(2026-10-09 실측 - TKM 첫 발행들이 전부
    //    이 폴백으로 Supabase 핫링크가 됐다). manifest를 못 읽으면 배포 이력을 API로 확인해 **0회일 때만** 빈 사이트로
    //    간주한다 - 일시 장애(이력 있음·확인 불가)를 빈 사이트로 오판하면 기존 이미지를 지운 스냅샷을 배포하게 된다.
    const previous: SiteManifest =
      (await readManifest().catch(async (error) => {
        if ((await deps.countDeployments(config).catch(() => -1)) === 0) return null;
        throw new Error(`이전 파일 목록(manifest.json)을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      })) ?? { version: 1, files: {} };

    const previousPaths = Object.keys(previous.files ?? {});
    if (previousPaths.length >= KSCENE_IMAGES_FILE_LIMIT_WARN) {
      throw new Error(`이미지 프로젝트 파일이 ${previousPaths.length}개로 한도(2만)에 가깝습니다 - KSCENE_IMAGES_PAGES_PROJECT를 새 프로젝트(예: 다음 해 이름)로 바꾸세요`);
    }

    const toRestore = previousPaths.filter((path) => !newPaths.has(path));
    await mapLimit(toRestore, DOWNLOAD_CONCURRENCY, async (path) => {
      const file = await deps.fetchBytes(`${baseUrl}/${path}`);
      if (!file) throw new Error(`기존 이미지를 받지 못했습니다(404): ${path}`);
      await mkdir(dirname(join(stagingDir, path)), { recursive: true });
      await writeFile(join(stagingDir, path), file.bytes);
    });

    // 3) 새 파일 + manifest + 캐시 헤더
    const alreadyPublished = [...newPaths].every((path) => previous.files?.[path]);
    const files: SiteManifest["files"] = { ...(previous.files ?? {}) };
    for (const { bytes, path } of downloaded.values()) {
      await mkdir(dirname(join(stagingDir, path)), { recursive: true });
      await writeFile(join(stagingDir, path), bytes);
      files[path] = { bytes: bytes.length };
    }
    await writeFile(join(stagingDir, MANIFEST_PATH), JSON.stringify({ version: 1, files } satisfies SiteManifest));
    await writeFile(join(stagingDir, HEADERS_FILE), HEADERS_BODY);

    // 4) 새 파일이 하나도 없으면(같은 이미지를 다시 발행) 배포하지 않는다 - 이미 서비스 중이다.
    let deployed = false;
    if (!alreadyPublished) {
      // **배포 직전에 목록을 한 번 더 읽는다**(2026-11-12). 재구성(기존 전량 내려받기)이 15~25초인데
      // Cloudflare 배포는 1.5초면 끝나므로, 그 사이에 다른 발행이 배포를 끝냈을 수 있다. 그 파일은 내
      // 스냅샷에 없어서 이대로 올리면 **내가 그 글의 이미지를 전부 지운다**(그날 가운데 글이 그렇게 죽었다).
      // 배포 목록 API로는 이미 끝난 그 배포가 "진행 중"으로 보이지 않으므로 락·드레인이 못 잡는다.
      const fresh = await readManifest().catch(() => null);
      const added = fresh ? Object.keys(fresh.files ?? {}).filter((path) => !previous.files?.[path] && !newPaths.has(path)) : [];
      if (added.length > 0) return { kind: "restart", added };

      console.log(`🖼 [rehost] 배포합니다 - 새 파일 ${newPaths.size}개 + 기존 ${previousPaths.length}개`);
      await deps.runWrangler(
        ["--yes", "wrangler@4", "pages", "deploy", stagingDir, "--project-name", projectName, "--branch", "main", "--commit-dirty=true"],
        { ...process.env, CLOUDFLARE_API_TOKEN: config.apiToken, CLOUDFLARE_ACCOUNT_ID: config.accountId }
      );
      deployed = true;
    }

    // 5) 서비스 중인지 확인한다. 안 되면 URL을 치환하지 않는다(깨진 이미지를 발행하지 않는다).
    const urlByIndex = new Map<number, string>();
    const sizeByIndex = new Map<number, { width: number; height: number } | null>();
    for (const [index, entry] of downloaded) {
      urlByIndex.set(index, `${baseUrl}/${entry.path}`);
      sizeByIndex.set(index, entry.size);
    }
    const probe = [...urlByIndex.values()][0];
    let live = false;
    for (let attempt = 0; attempt < LIVE_CHECK_ATTEMPTS; attempt += 1) {
      if (await deps.isLive(probe)) {
        live = true;
        break;
      }
      await deps.sleep(LIVE_CHECK_INTERVAL_MS);
    }
    // 6) 사후 검증: 내 파일이 **지금 사이트의** 파일 목록에 들어 있는가. 락을 잡는 틈에 시작된 다른 배포가
    //    내 신규 파일을 못 본 스냅샷을 올렸으면 여기서 걸린다(2026-10-15 사고의 그물). 서비스 확인이 실패한
    //    것도 대개 같은 원인이라, 던지기 전에 먼저 목록을 본다 - 덮인 것이면 재시도가 맞고 포기가 아니다.
    if (deployed) {
      // **진행 중인 배포가 다 끝난 뒤에** 본다(2026-10-31). 바로 확인하면 나를 덮을 배포가 아직 날아오는
      // 중이라 통과한 뒤에 덮인다 - 그날 세 건이 5초 안에 발행돼 셋 다 "진행 중 0건"을 보고 출발했고,
      // 먼저 끝난 두 건이 검증을 통과한 다음 마지막 배포에 덮여 이미지 12장이 404가 됐다.
      await waitForDeploymentsToDrain(config, deps);
      const verdict = await verifyDeployedFiles(newPaths, readManifest, deps);
      if (verdict.kind === "clobbered") return { kind: "clobbered", missing: verdict.missing };
      if (verdict.kind === "unknown") {
        // 못 읽은 것을 "이상 없음"으로 넘기면 **덮인 줄 모르고 성공으로 끝난다**(2026-11-12의 조용한 실패).
        // 실패로 올려 Supabase URL로 발행하고 경고를 남긴다 - 그 경고가 알림으로 나간다.
        throw new Error(`배포한 파일이 목록에 들어갔는지 확인하지 못했습니다(${VERIFY_READ_ATTEMPTS}회 시도): ${verdict.detail}`);
      }
      console.log(`✅ [rehost] 배포 검증 통과 - 내 파일 ${newPaths.size}개가 지금 사이트 목록에 있습니다`);
    }
    if (!live) throw new Error(`배포 후 ${(LIVE_CHECK_ATTEMPTS * LIVE_CHECK_INTERVAL_MS) / 1000}초 안에 새 이미지가 서비스되지 않았습니다(${probe})`);

    const rehostedImages = images.map((image) => {
      const url = urlByIndex.get(image.index);
      if (!url) return image;
      const size = sizeByIndex.get(image.index);
      return size ? { ...image, url, width: size.width, height: size.height } : { ...image, url };
    });
    return {
      kind: "done",
      result: {
        images: rehostedImages,
        rehosted: downloaded.size + alreadyDone,
        complete: failures.length === 0 && rehostedImages.every((image) => !image.url || isOurs(image.url)),
        deployed,
        failures,
      },
    };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return { kind: "done", result: passthrough() };
  } finally {
    await deps.removeDir(stagingDir).catch(() => {});
  }
}

// ---------- 기본 구현(네트워크·wrangler·파일시스템) ----------

async function defaultCountDeployments(config: KoreaplainImagesConfig): Promise<number> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.projectName}/deployments?per_page=1`,
    { headers: { Authorization: `Bearer ${config.apiToken}` }, signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok) throw new Error(`Cloudflare API ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { result?: unknown[]; result_info?: { total_count?: number } };
  return body.result_info?.total_count ?? body.result?.length ?? 0;
}

/** 진행 중인 배포 수. latest_stage.status가 끝난 상태(success·failure·skipped·canceled)가 아니면 진행 중으로 본다. */
async function defaultCountActiveDeployments(config: KoreaplainImagesConfig): Promise<number> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.projectName}/deployments?per_page=10`,
    { headers: { Authorization: `Bearer ${config.apiToken}` }, signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok) throw new Error(`Cloudflare API ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { result?: { latest_stage?: { status?: string } }[] };
  const finished = new Set(["success", "failure", "skipped", "canceled"]);
  return (body.result ?? []).filter((deployment) => !finished.has(deployment.latest_stage?.status ?? "success")).length;
}

async function defaultFetchBytes(url: string): Promise<FetchedBytes | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} (${url})`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
}

export function defaultRehostDeps(): RehostDeps {
  return {
    fetchBytes: defaultFetchBytes,
    countDeployments: defaultCountDeployments,
    countActiveDeployments: defaultCountActiveDeployments,
    runWrangler: (args, env) =>
      new Promise<void>((resolve, reject) => {
        // cwd에 functions/가 있으면 wrangler가 Pages Functions로 묶어 올린다 - 레포 루트(PIPELINE_ROOT)에는 뷰어용
        // functions/api가 있어 공개 이미지 프로젝트에 API가 딸려 간다(2026-10-09 실측). 스테이징 디렉터리에서 실행한다.
        const stagingDir = args[args.indexOf("deploy") + 1] ?? tmpdir();
        execFile("npx", args, { cwd: stagingDir, env, timeout: 10 * 60 * 1000 }, (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr?.trim() || error.message));
          else resolve();
        });
      }),
    isLive: async (url) => {
      try {
        const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000), headers: { "Cache-Control": "no-cache" } });
        return response.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    makeStagingDir: () => mkdtemp(join(tmpdir(), "kscene-images-")),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    acquireProjectLock: async ({ jobId, config }) => {
      if (!config.projectName) return null;
      const { acquirePagesDeployLock, lockHolderId } = await import("./pagesDeployLock.js");
      const result = await acquirePagesDeployLock({ project: config.projectName, holder: lockHolderId(jobId) });
      if (result.status === "held") {
        if (result.waitedMs > 1_000) console.log(`⏳ [rehost] 앞 발행의 배포를 ${Math.round(result.waitedMs / 1000)}초 기다렸습니다`);
        return result.handle;
      }
      // 락이 없어도 발행은 진행한다 - 배포 직전 재확인과 검증 후 지켜보기가 받는다.
      console.warn(
        result.status === "unavailable"
          ? `⚠️ [rehost] 배포 락 테이블이 없어 락 없이 진행합니다(migration 미적용): ${result.detail}`
          : `⚠️ [rehost] 배포 락을 ${Math.round(LOCK_WAIT_MS / 60000)}분 기다렸는데 안 풀려 락 없이 진행합니다(holder=${result.holder ?? "?"})`
      );
      return null;
    },
  };
}
