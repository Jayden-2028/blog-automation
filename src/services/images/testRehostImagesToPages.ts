// 발행 이미지 Pages 복사 테스트 - 네트워크·wrangler 없음(전부 주입, 스테이징은 실제 임시 디렉터리).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadKsceneImagesConfig } from "../../config/ksceneImages.js";
import type { ManuscriptImage } from "../../workflows/manuscripts/manuscriptManifest.js";
import { defaultRehostDeps, pagesImagePath, rehostImagesToPages } from "./rehostImagesToPages.js";
import type { RehostDeps } from "./rehostImagesToPages.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

const BASE = "https://kscene-images-2026.pages.dev";
const CONFIG = loadKsceneImagesConfig({ KSCENE_IMAGES_PAGES_PROJECT: "kscene-images-2026", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" });
const JOB = "abcdef12-0000-4000-8000-000000000000";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const image = (index: number, url: string | null): ManuscriptImage =>
  ({ index, description: `d${index}`, prompt: null, url, provider: "openai", fileName: `${index}.webp` }) as ManuscriptImage;

type Site = Map<string, Uint8Array>;

/** 가짜 Pages 사이트: 배포하면 스테이징 디렉터리 내용으로 사이트가 통째로 교체된다(스냅샷 의미 그대로). */
function makeWorld(initialSite: Site = new Map(), sources: Record<string, string | null | Error> = {}) {
  const world = {
    site: initialSite,
    deploys: [] as { args: string[]; files: string[] }[],
    sleeps: 0,
    liveAfter: 0, // isLive가 이 횟수만큼 거짓
    liveCalls: 0,
    sources,
  };
  const deps: RehostDeps = {
    ...defaultRehostDeps(),
    fetchBytes: async (url) => {
      if (url.startsWith(`${BASE}/`)) {
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
      world.deploys.push({ args, files: files.sort() });
    },
    isLive: async (url) => {
      world.liveCalls += 1;
      return world.liveCalls > world.liveAfter && world.site.has(url.slice(BASE.length + 1));
    },
    sleep: async () => {
      world.sleeps += 1;
    },
  };
  return { world, deps };
}

async function main(): Promise<void> {
  assert(!loadKsceneImagesConfig({}).enabled && !loadKsceneImagesConfig({ KSCENE_IMAGES_PAGES_PROJECT: "p" }).enabled, "프로젝트·계정·토큰이 다 있어야 enabled");
  assert(CONFIG.enabled && CONFIG.baseUrl === BASE, "baseUrl 기본값은 <project>.pages.dev");
  assert(loadKsceneImagesConfig({ KSCENE_IMAGES_PAGES_PROJECT: "p", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", KSCENE_IMAGES_BASE_URL: "https://img.example.com/" }).baseUrl === "https://img.example.com", "커스텀 도메인은 끝 슬래시를 뗀다");
  console.log("  ✅ 설정");

  // 미설정 -> 그대로 통과(발행을 막지 않는다)
  {
    const { deps, world } = makeWorld();
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/x/1.webp")], config: loadKsceneImagesConfig({}) }, deps);
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
    assert(result.complete && world.sleeps === 3, `전파를 기다린 뒤 성공(대기 ${world.sleeps}회)`);
    const dead = makeWorld(new Map(), { "https://supabase/g/1.webp": "NEVER" });
    dead.world.liveAfter = 999;
    const failed = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/g/1.webp")], config: CONFIG }, dead.deps);
    assert(!failed.complete && failed.images[0].url === "https://supabase/g/1.webp" && failed.failures.some((f) => f.includes("서비스되지 않았습니다")), "끝내 안 열리면 깨진 URL을 발행하지 않는다");
    console.log("  ✅ 배포 후 서비스 확인(전파 대기·실패 시 미치환)");
  }

  // 파일 한도 경고
  {
    const files = Object.fromEntries(Array.from({ length: 19_000 }, (_, i) => [`x/${i}.webp`, { bytes: 1 }]));
    const full = makeWorld(new Map([["manifest.json", bytes(JSON.stringify({ version: 1, files }))]]), { "https://supabase/h/1.webp": "Z" });
    const result = await rehostImagesToPages({ jobId: JOB, images: [image(1, "https://supabase/h/1.webp")], config: CONFIG }, full.deps);
    assert(!result.complete && full.world.deploys.length === 0 && result.failures.some((f) => f.includes("새 프로젝트")), "한도 근접 시 새 프로젝트로 바꾸라고 알리고 배포하지 않는다");
    console.log("  ✅ 파일 한도 근접 경고");
  }

  console.log("\n✅ testRehostImagesToPages 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
