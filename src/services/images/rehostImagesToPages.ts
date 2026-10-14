// 발행 이미지를 공개 Cloudflare Pages 프로젝트로 복사한다(개편3 §4.3-4). 설정은 config/ksceneImages.ts 머리말.
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
// manifest는 **캐시를 우회해서** 읽는다 - `_headers`의 `/*` 영구 캐시가 manifest.json에도 걸려 있어서(실측:
// `cache-control: max-age=31536000, immutable`) 캐시된 옛 목록을 읽으면 경합 없이도 같은 사고가 난다.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { KSCENE_IMAGES_FILE_LIMIT_WARN } from "../../config/ksceneImages.js";
import type { KsceneImagesConfig } from "../../config/ksceneImages.js";
import type { ManuscriptImage } from "../../workflows/manuscripts/manuscriptManifest.js";

export type FetchedBytes = { bytes: Uint8Array; contentType: string | null };

export type RehostDeps = {
  /** URL의 바이트를 받는다. 실패는 던진다. 404는 `null`(manifest 최초 부재 구분용). */
  fetchBytes: (url: string) => Promise<FetchedBytes | null>;
  /** Pages 프로젝트의 배포 횟수(미배포 프로젝트 판별용). 실패는 던진다. */
  countDeployments: (config: KsceneImagesConfig) => Promise<number>;
  /**
   * 지금 **진행 중인** 배포 수(락). 0이면 배포해도 안전하다. 실패는 던진다 - 호출자가 "확인 불가"로
   * 보고 그냥 진행한다(락을 못 잡아 발행을 막는 것보다 사후 검증에 맡기는 쪽이 낫다).
   */
  countActiveDeployments: (config: KsceneImagesConfig) => Promise<number>;
  /** `wrangler pages deploy <dir> ...` 실행. */
  runWrangler: (args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  /** 새 URL이 실제로 서비스되는지 확인한다(배포 직후 전파 대기). */
  isLive: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** 스테이징 디렉터리 생성/정리. */
  makeStagingDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
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
  input: { jobId: string; images: readonly ManuscriptImage[]; config: KsceneImagesConfig },
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
  const downloaded = new Map<number, { bytes: Uint8Array; path: string }>();
  await mapLimit(targets, 4, async (image) => {
    try {
      const fetched = await deps.fetchBytes(image.url as string);
      if (!fetched || fetched.bytes.length === 0) throw new Error("빈 응답");
      const ext = extensionFor(fetched.contentType, image.url as string);
      downloaded.set(image.index, { bytes: fetched.bytes, path: pagesImagePath(jobId, image.index, fetched.bytes, ext) });
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

  // 다른 배포가 돌고 있으면 기다린다(락). 다투는 자원이 Pages 프로젝트라 그 자원을 직접 본다.
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
    const active = await deps.countActiveDeployments(config).catch(() => 0); // 확인 불가면 진행한다 - 사후 검증이 받는다.
    if (active === 0) break;
    if (attempt === 0) console.log(`⏳ [rehost] 같은 프로젝트에 배포 ${active}건이 진행 중입니다 - 끝나기를 기다립니다`);
    await deps.sleep(LOCK_WAIT_INTERVAL_MS);
  }

  for (let round = 1; round <= CLOBBER_ATTEMPTS; round += 1) {
    const outcome = await deployRound(
      { jobId, images, config, baseUrl, projectName: config.projectName, downloaded, newPaths, alreadyDone, failures, isOurs, readManifest },
      deps
    );
    if (outcome.kind === "done") return outcome.result;
    // 다른 배포가 내 파일을 덮었다. 그 배포가 끝나길 기다린 뒤 재구성부터 다시 한다.
    console.warn(`⚠️ [rehost] 배포한 파일이 사라졌습니다(동시 배포에 덮였습니다) - ${round}/${CLOBBER_ATTEMPTS}회차, 다시 시도합니다: ${outcome.missing.join(", ")}`);
    if (round === CLOBBER_ATTEMPTS) {
      failures.push(`동시 배포에 ${CLOBBER_ATTEMPTS}번 연속 덮였습니다(${outcome.missing.join(", ")}) - Supabase URL로 발행합니다`);
      return passthrough(failures);
    }
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      const active = await deps.countActiveDeployments(config).catch(() => 0);
      if (active === 0) break;
      await deps.sleep(LOCK_WAIT_INTERVAL_MS);
    }
  }
  return passthrough(failures);
}

type RoundInput = {
  jobId: string;
  images: readonly ManuscriptImage[];
  config: KsceneImagesConfig;
  baseUrl: string;
  projectName: string;
  downloaded: Map<number, { bytes: Uint8Array; path: string }>;
  newPaths: Set<string>;
  alreadyDone: number;
  failures: string[];
  isOurs: (url: string | null) => boolean;
  readManifest: () => Promise<SiteManifest | null>;
};

type RoundOutcome = { kind: "done"; result: RehostResult } | { kind: "clobbered"; missing: string[] };

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
      await deps.runWrangler(
        ["--yes", "wrangler@4", "pages", "deploy", stagingDir, "--project-name", projectName, "--branch", "main", "--commit-dirty=true"],
        { ...process.env, CLOUDFLARE_API_TOKEN: config.apiToken, CLOUDFLARE_ACCOUNT_ID: config.accountId }
      );
      deployed = true;
    }

    // 5) 서비스 중인지 확인한다. 안 되면 URL을 치환하지 않는다(깨진 이미지를 발행하지 않는다).
    const urlByIndex = new Map<number, string>();
    for (const [index, entry] of downloaded) urlByIndex.set(index, `${baseUrl}/${entry.path}`);
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
      const current = await readManifest().catch(() => null);
      const missing = current ? [...newPaths].filter((path) => !current.files?.[path]) : [];
      if (missing.length > 0) return { kind: "clobbered", missing };
    }
    if (!live) throw new Error(`배포 후 ${(LIVE_CHECK_ATTEMPTS * LIVE_CHECK_INTERVAL_MS) / 1000}초 안에 새 이미지가 서비스되지 않았습니다(${probe})`);

    const rehostedImages = images.map((image) => {
      const url = urlByIndex.get(image.index);
      return url ? { ...image, url } : image;
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

async function defaultCountDeployments(config: KsceneImagesConfig): Promise<number> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.projectName}/deployments?per_page=1`,
    { headers: { Authorization: `Bearer ${config.apiToken}` }, signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok) throw new Error(`Cloudflare API ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { result?: unknown[]; result_info?: { total_count?: number } };
  return body.result_info?.total_count ?? body.result?.length ?? 0;
}

/** 진행 중인 배포 수. latest_stage.status가 끝난 상태(success·failure·skipped·canceled)가 아니면 진행 중으로 본다. */
async function defaultCountActiveDeployments(config: KsceneImagesConfig): Promise<number> {
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
  };
}
