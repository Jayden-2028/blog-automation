// 뷰어 "🗂 이미지 ZIP" 버튼 테스트(2026-11-06). 실행: npm run test:viewer-image-zip
//
// 지켜야 할 것:
//  ① 전 트랙 페이지에 ZIP 버튼이 있고, **낱장 버튼도 그대로** 있다(ZIP은 더한 것이다).
//  ② 이미지가 0장인 원고에는 둘 다 없다.
//  ③ 뷰어 발행 버튼 구조(사회·사용설명서만)는 건드리지 않았다.
//  ④ 실제 브라우저에서 눌러 받은 파일이 **진짜 ZIP**이다 - 시스템 unzip이 CRC까지 통과시키고,
//     풀어 보면 서버가 준 바이트가 그대로 나오고, 404난 자리는 빠지고 몇 장 빠졌는지 말한다.
//  ⑤ ZIP 파일명이 어느 원고인지 말한다(날짜 + 제목).
//
// 뷰어 스크립트는 템플릿 문자열 안에 있어 tsc가 문법 오류도 못 잡으므로 ④는 Chromium으로 연다
// (testImageNotes.ts와 같은 방식, PLAYWRIGHT_CHROMIUM_PATH로 브라우저 경로를 바꿀 수 있다).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { renderManuscriptPage } from "./renderManuscriptPage.js";
import type { ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { Track } from "../../notifications/telegramTracks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = ["도입 문단입니다.", "[IMAGE: 첫 자리]", "둘째 문단입니다.", "[IMAGE: 둘째 자리]", "셋째 문단입니다.", "[IMAGE: 셋째 자리]"].join("\n\n");

/** 서버가 줄 바이트. 길이를 다르게 둬 ZIP 안에서 자리가 섞이지 않았는지 본다. */
const SERVED: Record<string, Uint8Array> = {
  "https://x.supabase.co/storage/v1/object/public/article-images/01.png": new Uint8Array([1, 2, 3, 4, 5]),
  "https://x.supabase.co/storage/v1/object/public/article-images/02.jpg": new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 251)),
};
/** 404로 답할 주소 - 한 장이 사라진 원고다. */
const GONE = "https://x.supabase.co/storage/v1/object/public/article-images/03.jpg";

const IMAGES: ManuscriptImage[] = [
  { index: 1, description: "첫 자리", prompt: null, url: Object.keys(SERVED)[0], provider: "openai", fileName: "01-첫-자리.png" },
  { index: 2, description: "둘째 자리", prompt: null, url: Object.keys(SERVED)[1], provider: "web", fileName: "02-둘째-자리.jpg" },
  { index: 3, description: "셋째 자리", prompt: null, url: GONE, provider: "web", fileName: "03-셋째-자리.jpg" },
];

function topic(images: ManuscriptImage[], track?: Track): ManuscriptTopicEntry {
  return {
    jobId: "054bfe0b-1234-4abc-8def-0123456789ab",
    keyword: "테스트 키워드",
    category: "living",
    date: "2026-11-06",
    readyAt: "2026-11-06T00:00:00.000Z",
    manuscript: {
      title: "제목에 / 금지문자 있음",
      searchDescription: null,
      slug: "test-slug",
      tags: [],
      body: BODY,
      imagePrompts: [],
      images,
      filePath: "manuscripts/2026-11-06/테스트.md",
      ...(track && track !== "entertainment" ? { track } : {}),
    },
  };
}

function page(images: ManuscriptImage[], track: Track = "entertainment"): string {
  const manifest: ManuscriptManifest = { topics: [topic(images, track)] };
  return renderManuscriptPage(manifest, new Date("2026-11-06T09:00:00Z"), { track });
}

/**
 * ZIP 중앙 디렉터리를 걸어 항목 이름과 바이트를 읽는다. 무압축(store)이라 local header 뒤가
 * 곧 내용이다 - 구조가 제대로 서 있지 않으면 여기서 어긋난다.
 *
 * 시스템 unzip으로 **풀지는** 않는다 - macOS의 Info-ZIP이 UTF-8 한글 파일명을 로케일에 따라
 * "Illegal byte sequence"로 거부해 테스트가 환경에 매인다. CRC 검증은 아래 `unzip -t`가 한다.
 */
function zipEntries(buf: Buffer): { name: string; bytes: Buffer; flags: number }[] {
  const entries: { name: string; bytes: Buffer; flags: number }[] = [];
  for (let i = 0; i + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = buf.readUInt16LE(i + 28);
    const size = buf.readUInt32LE(i + 24);
    const offset = buf.readUInt32LE(i + 42);
    const localNameLength = buf.readUInt16LE(offset + 26);
    const localExtraLength = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLength + localExtraLength;
    entries.push({
      name: buf.subarray(i + 46, i + 46 + nameLength).toString("utf8"),
      bytes: buf.subarray(start, start + size),
      flags: buf.readUInt16LE(i + 8),
    });
  }
  return entries;
}

async function main(): Promise<void> {
  // ①③ - 정적 HTML만 봐도 판단된다.
  for (const track of ["entertainment", "social", "kscene"] as const) {
    const html = page(IMAGES, track);
    assert(html.includes('id="dl-zip"') && html.includes("🗂 이미지 ZIP("), `${track} 페이지에 ZIP 버튼이 있어야 한다`);
    assert(html.includes('id="dl-images"'), `${track} 페이지에 낱장 저장 버튼이 그대로 있어야 한다`);
    assert(html.includes("function downloadImagesZip") && html.includes("function buildZip") && html.includes("function crc32"), `${track} 페이지에 ZIP 조립 코드가 있어야 한다`);
    assert(!html.includes("jszip") && !html.includes("<script src="), `${track} 페이지는 외부 스크립트를 싣지 않는다`);
  }
  assert(!page(IMAGES, "entertainment").includes("/api/publish-request"), "엔터 페이지에 발행 요청 코드가 들어오지 않아야 한다");
  assert(page(IMAGES, "social").includes('id="publish-tistory"'), "사회 페이지 발행 버튼은 그대로여야 한다");
  assert(page(IMAGES, "kscene").includes('id="publish-blogspot"'), "사용설명서 페이지 발행 버튼은 그대로여야 한다");
  console.log("✅ ZIP 버튼은 전 트랙에, 낱장 버튼·발행 버튼 구조는 그대로");

  // ② 버튼은 madeCount > 0일 때만 그린다 - 눌러도 받을 게 없는 버튼을 두지 않는다(실제 확인은 ④에서).
  assert(page([]).includes("내려받을 이미지가 없습니다"), "데이터가 비는 경우의 안내 문구는 코드에 있어야 한다");

  // ④⑤ - 실제 브라우저에서 눌러 받는다.
  {
    const dir = mkdtempSync(resolve(tmpdir(), "viewer-zip-"));
    const htmlPath = resolve(dir, "index.html");
    writeFileSync(htmlPath, page(IMAGES), "utf8");

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      args: ["--no-sandbox"],
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    });
    try {
      const pageErrors: string[] = [];
      const tab = await browser.newPage({ acceptDownloads: true });
      tab.on("pageerror", (error) => pageErrors.push(String(error)));
      await tab.route("**/*", async (route) => {
        const url = route.request().url();
        // <img>는 부르지 않는다 - 테스트가 네트워크에 기대면 안 된다.
        if (route.request().resourceType() === "image") return route.abort();
        if (url === GONE) return route.fulfill({ status: 404, body: "gone", headers: { "access-control-allow-origin": "*" } });
        const body = SERVED[url];
        if (body) {
          // Supabase Storage 공개 객체와 같은 CORS 헤더(2026-11-06 실측) - 이게 없으면 바이트를 못 읽는다.
          return route.fulfill({ status: 200, body: Buffer.from(body), headers: { "access-control-allow-origin": "*", "content-type": "application/octet-stream" } });
        }
        return route.continue();
      });
      await tab.goto(`file://${htmlPath}`, { waitUntil: "load" });

      const [download] = await Promise.all([
        tab.waitForEvent("download", { timeout: 15000 }),
        tab.click("#dl-zip"),
      ]);
      assert(pageErrors.length === 0, `뷰어 스크립트 오류가 없어야 한다 (${pageErrors.join(" / ")})`);

      const suggested = download.suggestedFilename();
      assert(suggested === "2026-11-06-제목에-금지문자-있음-이미지.zip", `ZIP 파일명이 날짜 + 제목이어야 한다 (${suggested})`);

      const zipPath = resolve(dir, "downloaded.zip");
      await download.saveAs(zipPath);
      const buf = readFileSync(zipPath);
      assert(buf.subarray(0, 4).toString("binary") === "PK\u0003\u0004", "받은 파일이 ZIP이어야 한다");

      const entries = zipEntries(buf);
      assert(entries.length === 2, `받은 2장만 들어가야 한다 (${JSON.stringify(entries.map((e) => e.name))})`);
      assert(entries[0].name === "01-첫-자리.png" && entries[1].name === "02-둘째-자리.jpg", `파일명이 보관함과 같은 "번호-설명" 이어야 한다 (${JSON.stringify(entries.map((e) => e.name))})`);
      assert(entries.every((e) => (e.flags & 0x0800) !== 0), "한글 파일명이 깨지지 않게 UTF-8 플래그(bit 11)를 세워야 한다");
      assert(Buffer.compare(entries[0].bytes, Buffer.from(SERVED[Object.keys(SERVED)[0]])) === 0, "첫 장 바이트가 서버가 준 것과 같아야 한다");
      assert(Buffer.compare(entries[1].bytes, Buffer.from(SERVED[Object.keys(SERVED)[1]])) === 0, "둘째 장 바이트가 서버가 준 것과 같아야 한다");

      // 시스템 unzip으로 CRC까지 확인한다 - 우리가 쓴 헤더를 **남의 도구가** 받아들여야 한다.
      // unzip이 없는 환경에서는 건너뛴다(위 바이트 비교까지는 이미 통과한 상태다).
      try {
        execFileSync("unzip", ["-tqq", zipPath], { stdio: ["ignore", "ignore", "pipe"] });
        console.log("   · unzip -t 통과(CRC 포함)");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes("ENOENT")) console.log("   · unzip이 없어 CRC 검증은 건너뜀");
        else throw new Error(`❌ 시스템 unzip이 이 ZIP을 거부했다: ${detail}`);
      }

      const toastText = await tab.textContent("#toast");
      assert(toastText && toastText.includes("1장 빠짐") && toastText.includes("03-셋째-자리.jpg"), `빠진 장을 말해야 한다 (${toastText})`);
      console.log("✅ 브라우저에서 ZIP을 받고, unzip이 CRC까지 통과하고, 404난 자리는 빠졌다고 말한다");

      // 이미지 0장 원고 - 버튼 자체가 그려지지 않는다.
      const empty = resolve(dir, "empty.html");
      writeFileSync(empty, page([]), "utf8");
      const tab0 = await browser.newPage();
      await tab0.route("**/*", (route) => (route.request().resourceType() === "image" ? route.abort() : route.continue()));
      await tab0.goto(`file://${empty}`, { waitUntil: "load" });
      const buttons = await tab0.evaluate("({ zip: !!document.getElementById('dl-zip'), one: !!document.getElementById('dl-images') })") as { zip: boolean; one: boolean };
      assert(!buttons.zip && !buttons.one, `이미지 0장이면 ZIP·낱장 버튼을 그리지 않는다 (${JSON.stringify(buttons)})`);
      console.log("✅ 이미지 0장 원고에는 버튼을 그리지 않는다");

      // 전멸(전부 404)이면 ZIP을 만들지 않는다 - 빈 묶음을 받으면 받은 줄 알고 넘어간다.
      const allGone = resolve(dir, "gone.html");
      writeFileSync(allGone, page([{ ...IMAGES[2], index: 1 }]), "utf8");
      const tab2 = await browser.newPage({ acceptDownloads: true });
      const downloads: string[] = [];
      tab2.on("download", (d) => downloads.push(d.suggestedFilename()));
      await tab2.route("**/*", (route) => {
        if (route.request().resourceType() === "image") return route.abort();
        // 문서 자체(file://)는 그대로 열고, 이미지 주소(https)만 404로 답한다.
        if (!route.request().url().startsWith("http")) return route.continue();
        return route.fulfill({ status: 404, body: "gone", headers: { "access-control-allow-origin": "*" } });
      });
      await tab2.goto(`file://${allGone}`, { waitUntil: "load" });
      await tab2.click("#dl-zip");
      await tab2.waitForFunction("(document.querySelector('#toast').textContent || '').indexOf('한 장도') >= 0", null, { timeout: 10000 });
      assert(downloads.length === 0, `한 장도 못 받으면 ZIP을 내려주지 않는다 (${JSON.stringify(downloads)})`);
      const gonetoast = await tab2.textContent("#toast");
      assert(gonetoast && gonetoast.includes("낱장"), `낱장 버튼으로 안내해야 한다 (${gonetoast})`);
      console.log("✅ 한 장도 못 받으면 빈 ZIP을 주지 않고 낱장으로 안내한다");
    } finally {
      await browser.close();
    }
  }

  console.log("\n✅ 뷰어 이미지 ZIP 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
