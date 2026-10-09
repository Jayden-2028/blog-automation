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
// 같은 프로젝트에 동시에 두 발행이 겹치면 나중 배포가 먼저 것을 덮을 수 있다(스냅샷 재구성이 서로의 신규 파일을 못 보므로).
// 발행은 사람이 버튼을 누르는 저빈도 작업이라 락은 두지 않았다 - 알려진 한계(CURRENT_STATE에 기록).

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
const HEADERS_BODY = "/*\n  Cache-Control: public, max-age=31536000, immutable\n";
const DOWNLOAD_CONCURRENCY = 8;
const LIVE_CHECK_ATTEMPTS = 12;
const LIVE_CHECK_INTERVAL_MS = 5_000;

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

  const stagingDir = await deps.makeStagingDir();
  try {
    // 2) 이전 스냅샷 재구성: manifest.json을 읽고 그 파일을 전부 내려받는다.
    //    새로 만든 Pages 프로젝트는 첫 배포 전까지 404가 아니라 522를 돌려준다(2026-10-09 실측 - TKM 첫 발행들이 전부
    //    이 폴백으로 Supabase 핫링크가 됐다). manifest를 못 읽으면 배포 이력을 API로 확인해 **0회일 때만** 빈 사이트로
    //    간주한다 - 일시 장애(이력 있음·확인 불가)를 빈 사이트로 오판하면 기존 이미지를 지운 스냅샷을 배포하게 된다.
    const manifestResponse = await deps.fetchBytes(`${baseUrl}/${MANIFEST_PATH}`).catch(async (error) => {
      if ((await deps.countDeployments(config).catch(() => -1)) === 0) return null;
      throw new Error(`이전 파일 목록(manifest.json)을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
    const previous: SiteManifest = manifestResponse
      ? (JSON.parse(Buffer.from(manifestResponse.bytes).toString("utf8")) as SiteManifest)
      : { version: 1, files: {} };

    const previousPaths = Object.keys(previous.files ?? {});
    if (previousPaths.length >= KSCENE_IMAGES_FILE_LIMIT_WARN) {
      throw new Error(`이미지 프로젝트 파일이 ${previousPaths.length}개로 한도(2만)에 가깝습니다 - KSCENE_IMAGES_PAGES_PROJECT를 새 프로젝트(예: 다음 해 이름)로 바꾸세요`);
    }

    const newPaths = new Set([...downloaded.values()].map((entry) => entry.path));
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
        ["--yes", "wrangler@4", "pages", "deploy", stagingDir, "--project-name", config.projectName, "--branch", "main", "--commit-dirty=true"],
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
    if (!live) throw new Error(`배포 후 ${LIVE_CHECK_ATTEMPTS * LIVE_CHECK_INTERVAL_MS / 1000}초 안에 새 이미지가 서비스되지 않았습니다(${probe})`);

    const rehostedImages = images.map((image) => {
      const url = urlByIndex.get(image.index);
      return url ? { ...image, url } : image;
    });
    return {
      images: rehostedImages,
      rehosted: downloaded.size + alreadyDone,
      complete: failures.length === 0 && rehostedImages.every((image) => !image.url || isOurs(image.url)),
      deployed,
      failures,
    };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return passthrough(failures);
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
