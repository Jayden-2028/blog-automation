// 발행 이미지 Pages 복사 테스트 - 네트워크·wrangler 없음(전부 주입, 스테이징은 실제 임시 디렉터리).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadKoreaplainImagesConfig } from "../../config/koreaplainImages.js";
import type { ManuscriptImage } from "../../workflows/manuscripts/manuscriptManifest.js";
import { acquirePagesDeployLock, isLockTableMissing, lockHolderId } from "./pagesDeployLock.js";
import type { LockTable } from "./pagesDeployLock.js";
import { defaultRehostDeps, pagesImagePath, rehostImagesToPages } from "./rehostImagesToPages.js";
import type { RehostDeps } from "./rehostImagesToPages.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

const BASE = "https://kscene-images-2026.pages.dev";
const CONFIG = loadKoreaplainImagesConfig({ KSCENE_IMAGES_PAGES_PROJECT: "kscene-images-2026", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" });
const JOB = "abcdef12-0000-4000-8000-000000000000";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const image = (index: number, url: string | null): ManuscriptImage =>
  ({ index, description: `d${index}`, prompt: null, url, provider: "openai", fileName: `${index}.webp` }) as ManuscriptImage;

type Site = Map<string, Uint8Array>;

type World = {
  site: Site;
  deploys: { args: string[]; files: string[] }[];
  sleeps: number;
  liveAfter: number;
  liveCalls: number;
  siteDown: boolean;
  deployCount: number | null;
  active: number[];
  activeCalls: number;
  activeThrows: boolean;
  onDeploy: null | ((world: World) => void);
  sources: Record<string, string | null | Error>;
};

/** 가짜 Pages 사이트: 배포하면 스테이징 디렉터리 내용으로 사이트가 통째로 교체된다(스냅샷 의미 그대로). */
function makeWorld(initialSite: Site = new Map(), sources: Record<string, string | null | Error> = {}): { world: World; deps: RehostDeps } {
  const world: World = {
    site: initialSite,
    deploys: [] as { args: string[]; files: string[] }[],
    sleeps: 0,
    liveAfter: 0, // isLive가 이 횟수만큼 거짓
    liveCalls: 0,
    siteDown: false, // true면 사이트 요청이 522처럼 던진다(미배포 프로젝트 재현)
    deployCount: null, // countDeployments 응답(null이면 API 실패)
    active: [], // countActiveDeployments가 차례로 돌려줄 값(소진되면 0)
    activeCalls: 0,
    activeThrows: false,
    /** 배포 직후 실행된다 - 동시 배포가 내 파일을 덮는 상황을 흉내 낸다. */
    onDeploy: null,
    sources,
  };
  const deps: RehostDeps = {
    ...defaultRehostDeps(),
    fetchBytes: async (rawUrl) => {
      // manifest는 캐시 우회용 쿼리를 붙여 읽는다 - 가짜 사이트에서는 떼고 찾는다.
      const url = rawUrl.split("?")[0];
      if (url.startsWith(`${BASE}/`)) {
        if (world.siteDown) throw new Error(`522 <none> (${rawUrl})`);
        const file = world.site.get(url.slice(BASE.length + 1));
        return file ? { bytes: file, contentType: null } : null;
      }
      const source = world.sources[url];
      if (source instanceof Error) throw source;
      if (source === null || source === undefined) return null;
      return { bytes: bytes(source), contentType: url.endsWith(".png") ? "image/png" : "image/webp" };
    },
    runWrangler: async (args) => {
      const dir = args[args.indexOf("deploy") + 1];
      const files: string[] = [];
      const next: Site = new Map();
      const walk = async (rel: string): Promise<void> => {
        for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path);
          else {
            files.push(path);
            next.set(path, new Uint8Array(await readFile(join(dir, path))));
          }
        }
      };
      await walk("");
      world.site = next; // 스냅샷 교체
      world.siteDown = false; // 배포하면 사이트가 열린다(미배포 522 재현 뒤 정상화)
      world.deploys.push({ args, files: files.sort() });
      world.onDeploy?.(world);
    },
    countDeployments: async () => {
      if (world.deployCount === null) throw new Error("Cloudflare API 503");
      return world.deployCount;
    },
    countActiveDeployments: async () => {
      world.activeCalls += 1;
      if (world.activeThrows) throw new Error("Cloudflare API 503");
      return world.active.shift() ?? 0;
    },
    isLive: async (url) => {
      world.liveCalls += 1;
      return world.liveCalls > world.liveAfter && world.site.has(url.slice(BASE.length + 1));
    },
    sleep: async () => {
      world.sleeps += 1;
    },
    // 락은 아래 「배포 락」 블록에서 따로 본다 - 여기서는 "락 없이도 그물이 받는다"를 본다.
    acquireProjectLock: async () => null,
  };
  return { world, deps };
}

async function main(): Promise<void> {
  assert(!loadKoreaplainImagesConfig({}).enabled && !loadKoreaplainImagesConfig({ KSCENE_IMAGES_PAGES_PROJECT: "p" }).enabled, "프로젝트·계정·토큰이 다 있어야 enabled");
  assert(CONFIG.enabled && CONFIG.baseUrl === BASE, "baseUrl 기본값은 <project>.pages.dev");
  assert(loadKoreaplainImagesConfig({ KSCENE_IMAGES_PAGES_PROJECT: "p", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", KSCENE_IMAGES_BASE_URL: "https://img.example.com/" }).baseUrl === "https://img.example.com", "커스텀 도메인은 끝 슬래시를 뗀다");
  console.log("  ✅ 설정");

  // 미설정 -> 그대로 통과(발행을 막지 않는다)
  {
    const { deps, world } = makeWorld();
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/x/1.webp")], config: loadKoreaplainImagesConfig({}) }, deps);
    assert(!result.complete && result.images[0].url === "https://supabase/x/1.webp" && world.deploys.length === 0 && result.failures[0].includes("미설정"), "미설정이면 Supabase URL 그대로, 배포 없음");
    console.log("  ✅ 미설정 -> 통과");
  }

  // 첫 배포: manifest 없음(404)
  const src1 = "https://supabase/a/1.webp";
  const src2 = "https://supabase/a/2.png";
  const first = makeWorld(new Map(), { [src1]: "IMG-ONE", [src2]: "IMG-TWO" });
  const r1 = await rehostImagesToPages({ jobId: JOB, images: [image(1, src1), image(2, src2), image(3, null)], config: CONFIG }, first.deps);
  assert(r1.complete && r1.deployed && r1.rehosted === 2 && first.world.deploys.length === 1, "첫 배포 성공");
  const p1 = pagesImagePath(JOB, 1, bytes("IMG-ONE"), "webp");
  const p2 = pagesImagePath(JOB, 2, bytes("IMG-TWO"), "png");
  assert(p1.startsWith("abcdef12/1-") && p1.endsWith(".webp") && p2.endsWith(".png"), `경로: <jobId8>/<index>-<sha8>.<ext> (${p1}, ${p2})`);
  assert(r1.images[0].url === `${BASE}/${p1}` && r1.images[1].url === `${BASE}/${p2}` && r1.images[2].url === null, "URL 치환(빈 자리는 그대로)");
  assert(first.world.deploys[0].files.join() === [p1, p2, "_headers", "manifest.json"].sort().join(), `배포 파일 = 이미지 + _headers + manifest (${first.world.deploys[0].files})`);
  assert(first.world.deploys[0].args.includes("kscene-images-2026") && first.world.deploys[0].args.includes("pages"), "wrangler pages deploy 대상 프로젝트");
  const manifest = JSON.parse(Buffer.from(first.world.site.get("manifest.json")!).toString());
  assert(Object.keys(manifest.files).length === 2, "manifest에 파일 목록");
  assert(Buffer.from(first.world.site.get("_headers")!).toString().includes("immutable") && !Buffer.from(first.world.site.get("_headers")!).toString().includes("noindex"), "영구 캐시 헤더, noindex 없음");
  console.log("  ✅ 첫 배포(파일·manifest·헤더·URL 치환)");

  // 두 번째 글: 이전 스냅샷을 보존한다(Pages는 스냅샷이라 이게 핵심)
  const JOB2 = "99999999-0000-4000-8000-000000000000";
  const src3 = "https://supabase/b/1.webp";
  const second = makeWorld(first.world.site, { [src3]: "IMG-THREE" });
  const r2 = await rehostImagesToPages({ jobId: JOB2, images: [image(1, src3)], config: CONFIG }, second.deps);
  const p3 = pagesImagePath(JOB2, 1, bytes("IMG-THREE"), "webp");
  assert(r2.complete && second.world.deploys[0].files.join() === [p1, p2, p3, "_headers", "manifest.json"].sort().join(), `새 글을 배포해도 앞 글 이미지가 남는다 (${second.world.deploys[0].files})`);
  assert(Object.keys(JSON.parse(Buffer.from(second.world.site.get("manifest.json")!).toString()).files).length === 3, "manifest 누적");
  console.log("  ✅ 이전 스냅샷 재구성 - 기존 이미지 보존");

  // 같은 이미지 재발행: 배포 없음(멱등), URL은 같다
  const again = makeWorld(second.world.site, { [src3]: "IMG-THREE" });
  const r3 = await rehostImagesToPages({ jobId: JOB2, images: [image(1, src3)], config: CONFIG }, again.deps);
  assert(r3.complete && !r3.deployed && again.world.deploys.length === 0 && r3.images[0].url === `${BASE}/${p3}`, "이미 올라간 이미지는 다시 배포하지 않는다");
  // 이미 치환된 URL 입력(재발행 시 캐시된 metadata)은 그대로 통과
  const noop = await rehostImagesToPages({ jobId: JOB2, images: [image(1, `${BASE}/${p3}`)], config: CONFIG }, again.deps);
  assert(noop.complete && noop.rehosted === 1 && !noop.deployed, "이미 Pages 주소인 이미지는 건드리지 않는다");
  console.log("  ✅ 재발행 멱등");

  // 이전 파일 하나가 사라져 있으면 배포하지 않는다(부분 배포 = 기존 이미지 삭제)
  {
    const broken = new Map(second.world.site);
    broken.delete(p1);
    const { deps, world } = makeWorld(broken, { "https://supabase/c/1.webp": "IMG-FOUR" });
    const result = await rehostImagesToPages({ jobId: "55555555-0000-4000-8000-000000000000", images: [image(1, "https://supabase/c/1.webp")], config: CONFIG }, deps);
    assert(!result.complete && !result.deployed && world.deploys.length === 0 && result.images[0].url === "https://supabase/c/1.webp", "이전 이미지를 못 받으면 배포하지 않고 Supabase URL 유지");
    assert(result.failures.some((f) => f.includes("기존 이미지")), "실패 사유");
    console.log("  ✅ 스냅샷 재구성 실패 -> 배포 안 함");
  }

  // 미배포 프로젝트: 첫 배포 전 Pages는 404가 아니라 522를 던진다(2026-10-09 실측). 배포 이력 0이 확인될 때만 빈 사이트로 간주한다.
  {
    const fresh = makeWorld(new Map(), { "https://supabase/i/1.webp": "BOOT" });
    fresh.world.siteDown = true;
    fresh.world.deployCount = 0;
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/i/1.webp")], config: CONFIG }, fresh.deps);
    assert(result.complete && result.deployed && fresh.world.deploys.length === 1, "배포 이력 0이면 522여도 첫 배포로 진행");
    console.log("  ✅ 미배포 프로젝트(522) -> 배포 이력 0 확인 후 첫 배포");
  }
  {
    // 배포 이력이 있는데 사이트가 안 열리면(일시 장애) 빈 스냅샷 배포로 기존 이미지를 지우면 안 된다
    const outage = makeWorld(new Map(), { "https://supabase/j/1.webp": "RISK" });
    outage.world.siteDown = true;
    outage.world.deployCount = 7;
    const r = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/j/1.webp")], config: CONFIG }, outage.deps);
    assert(!r.complete && outage.world.deploys.length === 0 && r.failures.some((f) => f.includes("manifest.json")), "배포 이력이 있으면 중단(기존 이미지 보호)");
    // API 확인 자체가 실패해도 중단한다
    const unknown = makeWorld(new Map(), { "https://supabase/k/1.webp": "RISK2" });
    unknown.world.siteDown = true;
    unknown.world.deployCount = null;
    const r2 = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/k/1.webp")], config: CONFIG }, unknown.deps);
    assert(!r2.complete && unknown.world.deploys.length === 0, "이력 확인 불가면 중단");
    console.log("  ✅ 사이트 장애(이력 있음·확인 불가) -> 배포 안 함");
  }

  // 일부 원본 다운로드 실패: 받은 것만 옮기고 complete=false
  {
    const { deps, world } = makeWorld(new Map(), { "https://supabase/d/1.webp": "OK-IMG", "https://supabase/d/2.webp": new Error("503") });
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/d/1.webp"), image(2, "https://supabase/d/2.webp")], config: CONFIG }, deps);
    assert(world.deploys.length === 1 && !result.complete && result.images[0].url?.startsWith(BASE) && result.images[1].url === "https://supabase/d/2.webp", "받은 자리만 옮기고 나머지는 Supabase URL, complete=false");
    assert(result.failures.some((f) => f.includes("이미지 2")), "실패한 자리 보고");
    console.log("  ✅ 일부 원본 실패 -> 부분 성공(complete=false라 정리 대상 표식 안 남음)");
  }
  {
    const { deps, world } = makeWorld(new Map(), {});
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/e/1.webp")], config: CONFIG }, deps);
    assert(!result.complete && world.deploys.length === 0, "원본을 하나도 못 받으면 배포하지 않는다");
  }

  // 배포 후 서비스 확인: 전파 대기 후 성공 / 끝내 안 되면 치환하지 않는다
  {
    const { deps, world } = makeWorld(new Map(), { "https://supabase/f/1.webp": "SLOW" });
    world.liveAfter = 3;
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/f/1.webp")], config: CONFIG }, deps);
    // 대기 = 전파 3회 + 검증 통과 뒤 지켜보기(2026-11-12).
    assert(result.complete && world.sleeps >= 3, `전파를 기다린 뒤 성공(대기 ${world.sleeps}회)`);
    const dead = makeWorld(new Map(), { "https://supabase/g/1.webp": "NEVER" });
    dead.world.liveAfter = 999;
    const failed = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/g/1.webp")], config: CONFIG }, dead.deps);
    assert(!failed.complete && failed.images[0].url === "https://supabase/g/1.webp" && failed.failures.some((f) => f.includes("서비스되지 않았습니다")), "끝내 안 열리면 깨진 URL을 발행하지 않는다");
    console.log("  ✅ 배포 후 서비스 확인(전파 대기·실패 시 미치환)");
  }

  // 동시 배포 락: 진행 중인 배포가 끝나기를 기다린 뒤 재구성한다(2026-10-15 사고).
  {
    const { deps, world } = makeWorld(new Map(), { "https://supabase/l/1.webp": "LOCKED" });
    world.active = [2, 1]; // 두 번 기다린 뒤 0
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/l/1.webp")], config: CONFIG }, deps);
    assert(result.complete && world.deploys.length === 1 && world.sleeps >= 2, `진행 중인 배포를 기다린 뒤 배포(대기 ${world.sleeps}회)`);
    // 락 확인 자체가 실패하면 막지 않고 진행한다(사후 검증이 받는다)
    const blind = makeWorld(new Map(), { "https://supabase/m/1.webp": "BLIND" });
    blind.world.activeThrows = true;
    const r = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/m/1.webp")], config: CONFIG }, blind.deps);
    assert(r.complete && blind.world.deploys.length === 1, "락 확인 불가 -> 기다리지 않고 진행");
    console.log("  ✅ 동시 배포 락(대기·확인 불가 시 진행)");
  }

  // 사후 검증: 배포 직후 다른 배포가 내 파일을 덮으면 다시 시도한다
  {
    const src = "https://supabase/n/1.webp";
    const { deps, world } = makeWorld(new Map(), { [src]: "CLOBBER-ME" });
    const mine = pagesImagePath(JOB, 1, bytes("CLOBBER-ME"), "webp");
    // 첫 배포 직후에만 다른 배포가 끼어들어 내 파일 없는 스냅샷으로 사이트를 바꾼다.
    world.onDeploy = (w) => {
      w.onDeploy = null;
      const theirs: Site = new Map<string, Uint8Array>([["zzzzzzzz/1-00000000.webp", bytes("THEIRS")]]);
      theirs.set("manifest.json", bytes(JSON.stringify({ version: 1, files: { "zzzzzzzz/1-00000000.webp": { bytes: 6 } } })));
      w.site = theirs;
    };
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, src)], config: CONFIG }, deps);
    assert(result.complete && result.images[0].url === `${BASE}/${mine}`, `덮인 뒤 재시도해서 성공해야 한다 (${JSON.stringify(result.failures)})`);
    assert(world.deploys.length === 2, `재배포 1회 (배포 ${world.deploys.length}회)`);
    assert(world.site.has(mine) && world.site.has("zzzzzzzz/1-00000000.webp"), "재시도 때는 끼어든 배포의 파일까지 보존한다");
    console.log("  ✅ 사후 검증 - 덮이면 재구성·재배포");
  }
  {
    // 계속 덮이면 포기하고 Supabase URL로 둔다(깨진 URL을 발행하지 않는다)
    const src = "https://supabase/o/1.webp";
    const { deps, world } = makeWorld(new Map(), { [src]: "ALWAYS-CLOBBERED" });
    world.onDeploy = (w) => {
      w.site = new Map<string, Uint8Array>([["manifest.json", bytes(JSON.stringify({ version: 1, files: {} }))]]);
    };
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, src)], config: CONFIG }, deps);
    assert(!result.complete && result.images[0].url === src, "끝내 덮이면 Supabase URL 유지");
    assert(world.deploys.length === 3 && result.failures.some((f) => f.includes("덮였습니다")), `3회 시도 후 포기 (${world.deploys.length}회, ${JSON.stringify(result.failures)})`);
    console.log("  ✅ 반복 덮임 -> 포기(깨진 URL 미발행)");
  }

  // manifest는 캐시를 우회해 읽는다 - 영구 캐시된 옛 목록을 읽으면 기존 이미지가 지워진다
  {
    const { deps, world } = makeWorld(new Map(), { "https://supabase/p/1.webp": "FRESH" });
    const reads: string[] = [];
    const spied: RehostDeps = { ...deps, fetchBytes: async (url) => (reads.push(url), deps.fetchBytes(url)) };
    await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/p/1.webp")], config: CONFIG }, spied);
    assert(reads.some((u) => u.includes("manifest.json?")), `manifest 요청에 캐시 우회 쿼리가 붙어야 한다 (${reads.filter((u) => u.includes("manifest")).join()})`);
    const headers = Buffer.from(world.site.get("_headers")!).toString();
    assert(headers.includes("/manifest.json") && headers.includes("no-store"), `_headers가 manifest.json을 캐시 예외로 둬야 한다 (${headers})`);
    console.log("  ✅ manifest 캐시 우회(+ _headers 예외)");
  }

  // 파일 한도 경고
  {
    const files = Object.fromEntries(Array.from({ length: 19_000 }, (_, i) => [`x/${i}.webp`, { bytes: 1 }]));
    const full = makeWorld(new Map<string, Uint8Array>([["manifest.json", bytes(JSON.stringify({ version: 1, files }))]]), { "https://supabase/h/1.webp": "Z" });
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/h/1.webp")], config: CONFIG }, full.deps);
    assert(!result.complete && full.world.deploys.length === 0 && result.failures.some((f) => f.includes("새 프로젝트")), "한도 근접 시 새 프로젝트로 바꾸라고 알리고 배포하지 않는다");
    console.log("  ✅ 파일 한도 근접 경고");
  }

  // 2026-10-31 재현: 내 배포 **뒤에** 아직 날아오는 중이던 다른 배포가 내 파일을 덮는다.
  // 바로 검증하면 그 시점에는 멀쩡해서 통과한다 - 진행 중인 배포가 다 빠진 뒤에 봐야 잡힌다.
  {
    const folder = JOB.replace(/-/g, "").slice(0, 8);
    const { world, deps } = makeWorld(new Map(), { "https://supabase/late/1.webp": "L" });
    let clobbered = false;
    const spied: RehostDeps = {
      ...deps,
      countActiveDeployments: async () => {
        if (world.deploys.length === 0) return 0; // 셋이 같은 순간에 출발한 상황 - 락은 아무도 못 잡는다
        if (clobbered) return 0;
        clobbered = true;
        // 늦게 끝난 배포가 내 파일을 못 본 스냅샷을 올린다.
        const site: Site = new Map([...world.site].filter(([path]) => !path.startsWith(`${folder}/`)));
        const files = Object.fromEntries([...site].filter(([path]) => path !== "manifest.json").map(([path, b]) => [path, { bytes: b.length }]));
        site.set("manifest.json", bytes(JSON.stringify({ version: 1, files })));
        world.site = site;
        return 1; // 그 배포는 아직 진행 중이다
      },
    };
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/late/1.webp")], config: CONFIG }, spied);
    assert(world.deploys.length === 2, `덮인 것을 알아채고 다시 배포해야 한다 (배포 ${world.deploys.length}회)`);
    assert(result.complete && result.images[0].url?.startsWith(BASE), `재배포 뒤 Pages URL이어야 한다 (${result.images[0].url})`);
    assert([...world.site.keys()].some((path) => path.startsWith(`${folder}/`)), "최종 사이트에 내 파일이 남아야 한다");
    console.log("  ✅ 배포가 다 빠진 뒤 검증해 늦은 덮어쓰기를 잡는다(2026-10-31)");
  }

  // ---------- 2026-11-12 세 번째 재발(실측) ----------
  // 그날 세 편이 15초·13초 간격으로 발행됐는데 Cloudflare 배포는 **1.3~1.8초**만 걸렸다(API 실측:
  // 02:22:59.9→02:23:01.5, 02:23:15.2→02:23:16.5, 02:23:23.8→02:23:25.6). 즉 "진행 중인 배포"는
  // 거의 항상 0건이고, 정작 다투는 구간(**목록 읽기 → 배포 생성**, 재구성 때문에 15~25초)은
  // 배포 목록 API에 전혀 안 보인다. 락도 드레인도 매번 즉시 통과했고(세 run 모두 대기 로그 없음)
  // 가운데 글만 7장 전부 404가 됐다.
  {
    // ① 내가 **재구성하는 동안** 끝난 배포를 내 스냅샷이 지운다(가운데 글을 죽인 쪽).
    const old = "oldoldol/1-aaaaaaaa.webp";
    const theirs = "cccccccc/1-11111111.webp";
    const site: Site = new Map<string, Uint8Array>([[old, bytes("OLD")]]);
    site.set("manifest.json", bytes(JSON.stringify({ version: 1, files: { [old]: { bytes: 3 } } })));
    const src = "https://supabase/race1/1.webp";
    const { world, deps } = makeWorld(site, { [src]: "MINE-1" });
    let landed = false;
    const spied: RehostDeps = {
      ...deps,
      fetchBytes: async (url) => {
        const response = await deps.fetchBytes(url);
        // 목록을 읽은 직후 = 내가 재구성을 시작하는 순간. 다른 발행이 그 사이 배포를 끝낸다
        // (진행 중 배포 수로는 안 보인다 - 1.5초면 끝난다).
        if (!landed && url.includes("manifest.json")) {
          landed = true;
          const next: Site = new Map(world.site);
          next.set(theirs, bytes("THEIRS"));
          next.set("manifest.json", bytes(JSON.stringify({ version: 1, files: { [old]: { bytes: 3 }, [theirs]: { bytes: 6 } } })));
          world.site = next;
        }
        return response;
      },
    };
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, src)], config: CONFIG }, spied);
    assert(world.activeCalls > 0 && world.sleeps >= 0, "락은 호출됐다(그런데 0건만 본다)");
    assert(world.site.has(theirs), `재구성 중에 끝난 배포의 파일을 지워서는 안 된다 (남은 파일: ${[...world.site.keys()].join()})`);
    assert(result.complete && result.images[0].url?.startsWith(BASE) && world.site.has(old), "내 파일도 함께 올라간다");
    console.log("  ✅ 재구성 중에 끝난 배포를 지우지 않는다(2026-11-12 ①)");
  }
  {
    // ② 피해자 쪽: 사후 검증을 통과한 **뒤에** 늦게 날아온 배포가 내 파일을 덮는다. 그 배포는
    //    진행 중으로 잡히지 않으므로(드레인은 빈 순간을 본다) 검증을 한 번 보고 끝내면 못 잡는다.
    const src = "https://supabase/race2/1.webp";
    const { world, deps } = makeWorld(new Map(), { [src]: "MINE-2" });
    const folder = JOB.replace(/-/g, "").slice(0, 8);
    const theirs = "dddddddd/1-22222222.webp";
    let deployed = 0;
    let clobbered = false;
    const spied: RehostDeps = {
      ...deps,
      runWrangler: async (args) => {
        await deps.runWrangler(args, {});
        deployed += 1;
      },
      fetchBytes: async (url) => {
        const response = await deps.fetchBytes(url);
        // 배포 뒤 첫 검증 읽기는 멀쩡하게 통과시키고(그 시점 사진은 맞다), 바로 뒤에 늦은 배포가 덮는다.
        if (deployed === 1 && !clobbered && url.includes("manifest.json")) {
          clobbered = true;
          const next: Site = new Map([...world.site].filter(([path]) => !path.startsWith(`${folder}/`) && path !== "manifest.json"));
          next.set(theirs, bytes("THEIRS2"));
          next.set("manifest.json", bytes(JSON.stringify({ version: 1, files: { [theirs]: { bytes: 7 } } })));
          world.site = next;
        }
        return response;
      },
    };
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, src)], config: CONFIG }, spied);
    assert([...world.site.keys()].some((path) => path.startsWith(`${folder}/`)), `검증 뒤에 덮인 것도 알아채고 되살려야 한다 (남은 파일: ${[...world.site.keys()].join()})`);
    assert(result.complete && result.images[0].url?.startsWith(BASE), `복구 뒤 Pages URL (${result.images[0].url}, ${JSON.stringify(result.failures)})`);
    console.log("  ✅ 검증 통과 뒤 늦게 덮이는 것도 지켜본다(2026-11-12 ②)");
  }
  {
    // ③ 조용한 실패: 검증용 목록을 **못 읽었는데** 성공으로 끝내면 안 된다(그날 세 job 모두
    //    경고 한 줄 없이 끝났다 - 경고가 있었으면 알림이 갔다).
    const src = "https://supabase/race3/1.webp";
    const { world, deps } = makeWorld(new Map(), { [src]: "MINE-3" });
    let deployed = false;
    const spied: RehostDeps = {
      ...deps,
      runWrangler: async (args) => {
        await deps.runWrangler(args, {});
        deployed = true;
      },
      fetchBytes: async (url) => {
        if (deployed && url.includes("manifest.json")) throw new Error("503 Service Unavailable");
        return deps.fetchBytes(url);
      },
    };
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, src)], config: CONFIG }, spied);
    assert(!result.complete && result.images[0].url === src, `확인 못 한 배포를 성공으로 끝내지 않는다 (${result.images[0].url})`);
    assert(result.failures.some((f) => f.includes("확인")), `확인 실패를 경고로 남긴다 (${JSON.stringify(result.failures)})`);
    assert(world.deploys.length >= 1, "배포 자체는 했다");
    console.log("  ✅ 검증 불가 -> 조용히 성공하지 않는다(2026-11-12 ③)");
  }

  // ---------- 배포 락(2026-11-12) ----------
  // Cloudflare 배포 목록으로는 "스냅샷을 만드는 중"이 보이지 않으므로(배포 1.5초 vs 재구성 15~25초)
  // 러너들이 공유하는 Supabase 한 행으로 줄을 세운다. 테이블이 없으면(migration 미적용) 락 없이 진행한다.
  {
    type Row = { project: string; holder: string | null; locked_at: string | null; expires_at: string };
    const PROJECT = "kscene-images-2026";
    const fake = (rows: Map<string, Row>, missing = false): LockTable => {
      const fail = { data: null, error: { code: "42P01", message: "relation \"pages_deploy_lock\" does not exist" } };
      return {
        update: (patch) => ({
          eq: (_c, project) => ({
            // 비었거나 만료된 락 가로채기
            lte: (_c2, at) => ({
              select: async () => {
                if (missing) return fail;
                const row = rows.get(String(project));
                if (!row || new Date(row.expires_at).getTime() > new Date(String(at)).getTime()) return { data: [], error: null };
                Object.assign(row, patch);
                return { data: [{ project }], error: null };
              },
            }),
            // 해제(holder 일치할 때만)
            eq: (_c2, holder) => ({
              select: async () => {
                if (missing) return fail;
                const row = rows.get(String(project));
                if (!row || row.holder !== holder) return { data: [], error: null };
                Object.assign(row, patch);
                return { data: [{ project }], error: null };
              },
            }),
          }),
        }),
        insert: (row) => ({
          select: async () => {
            if (missing) return fail;
            const key = String(row.project);
            if (rows.has(key)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            rows.set(key, { project: key, holder: (row.holder as string) ?? null, locked_at: (row.locked_at as string) ?? null, expires_at: String(row.expires_at) });
            return { data: [{ project: key }], error: null };
          },
        }),
        select: () => ({ eq: (_c, project) => ({ maybeSingle: async () => ({ data: rows.get(String(project)) ?? null, error: null }) }) }),
      };
    };

    // 빈 테이블 -> 행을 만들어 잡는다. 해제하면 expires_at이 지금으로 당겨져 다음 발행이 곧바로 가져간다.
    const rows = new Map<string, Row>();
    const first = await acquirePagesDeployLock({ project: PROJECT, holder: "run-1:job-a" }, { table: () => fake(rows) });
    assert(first.status === "held", `빈 테이블에서는 잡는다 (${first.status})`);
    assert(rows.get(PROJECT)?.holder === "run-1:job-a" && new Date(rows.get(PROJECT)!.expires_at).getTime() > Date.now(), "holder와 리스가 남는다");

    // 쥐고 있는 동안 다른 발행은 못 잡고 기다린다(상한을 넘기면 락 없이 진행한다).
    let slept = 0;
    const blocked = await acquirePagesDeployLock(
      { project: PROJECT, holder: "run-2:job-b" },
      { table: () => fake(rows), waitMs: 20, sleep: async () => { slept += 1; } }
    );
    assert(blocked.status === "timeout" && slept > 0, `쥐고 있으면 기다린다 (${blocked.status}, 대기 ${slept}회)`);
    assert(blocked.status === "timeout" && blocked.holder === "run-1:job-a", "누가 쥐고 있는지 보고한다");
    assert(rows.get(PROJECT)?.holder === "run-1:job-a", "기다리는 쪽이 holder를 덮지 않는다");

    if (first.status === "held") await first.handle.release();
    const second = await acquirePagesDeployLock({ project: PROJECT, holder: "run-2:job-b" }, { table: () => fake(rows) });
    assert(second.status === "held" && rows.get(PROJECT)?.holder === "run-2:job-b", `해제 뒤에는 다음 발행이 잡는다 (${second.status})`);

    // 러너가 죽어 release를 못 불렀을 때: 리스가 만료되면 다음 발행이 회수한다.
    rows.set(PROJECT, { project: PROJECT, holder: "run-dead:job-x", locked_at: null, expires_at: new Date(Date.now() - 1000).toISOString() });
    const reclaimed = await acquirePagesDeployLock({ project: PROJECT, holder: "run-3:job-c" }, { table: () => fake(rows) });
    assert(reclaimed.status === "held" && rows.get(PROJECT)?.holder === "run-3:job-c", `만료된 리스는 회수한다 (${reclaimed.status})`);

    // migration 미적용 -> unavailable(발행을 막지 않는다)
    const none = await acquirePagesDeployLock({ project: PROJECT, holder: "run-4:job-d" }, { table: () => fake(new Map(), true) });
    assert(none.status === "unavailable", `테이블이 없으면 락 없이 진행한다 (${none.status})`);
    assert(isLockTableMissing({ code: "42P01", message: "x" }) && isLockTableMissing({ code: "PGRST205", message: "x" }) && !isLockTableMissing({ code: "23505", message: "duplicate" }), "테이블 없음 판정");
    assert(lockHolderId("job-a").endsWith(":job-a"), "holder에 jobId가 들어간다");
    console.log("  ✅ 배포 락(획득·대기·해제·리스 회수·미적용 통과)");
  }
  {
    // rehost는 락을 잡고 **반드시 풀어 준다** - 성공이든 실패든. 안 풀면 다음 발행이 리스 만료까지 멈춘다.
    const order: string[] = [];
    const lock = { release: async () => void order.push("release") };
    const src = "https://supabase/lock/1.webp";
    const ok = makeWorld(new Map(), { [src]: "LOCKED-OK" });
    const okResult = await rehostImagesToPages(
      { jobId: JOB, images: [image(1, src)], config: CONFIG },
      { ...ok.deps, acquireProjectLock: async () => (order.push("acquire"), lock), runWrangler: async (args) => { order.push("deploy"); await ok.deps.runWrangler(args, {}); } }
    );
    assert(okResult.complete && order.join(">") === "acquire>deploy>release", `락 -> 배포 -> 해제 순서 (${order.join(">")})`);

    order.length = 0;
    const dead = makeWorld(new Map(), { "https://supabase/lock/2.webp": "NEVER" });
    dead.world.liveAfter = 999;
    const failed = await rehostImagesToPages(
      { jobId: JOB, images: [image(1, "https://supabase/lock/2.webp")], config: CONFIG },
      { ...dead.deps, acquireProjectLock: async () => (order.push("acquire"), lock) }
    );
    assert(!failed.complete && order.includes("release"), `실패해도 락을 풀어 준다 (${order.join(">")})`);
    console.log("  ✅ 배포 락은 성공·실패 모두 해제한다");
  }

  console.log("\n✅ testRehostImagesToPages 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
