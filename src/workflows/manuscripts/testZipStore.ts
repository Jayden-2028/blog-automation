// zipStore가 만든 zip이 실제로 풀리는지 검증한다. 직접 만든 ZIP 바이너리라 "열리는 것처럼
// 보이는" 것으로는 부족해 `unzip -t`(CRC 검사)와 `unzip -p`(내용 비교)로 확인한다.
//
// 뒷부분은 **뷰어 페이지에 인라인된 사본**을 HTML에서 도로 긁어내 같은 검사를 돌린다.
// 인라인은 zipStore.toString()으로 하는데, 트랜스파일 결과가 자기 완결이 아니면(바깥 헬퍼를
// 참조하면) 브라우저에서만 터진다 - 그 사고를 Node에서 미리 잡으려는 것이다.
//
// 실행: npm run test:zip-store
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { renderManuscriptPage } from "./renderManuscriptPage.js";
import { zipStore } from "./zipStore.js";
import type { ZipEntry } from "./zipStore.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** 한글 파일명 + 바이너리 + 빈 파일까지 섞은 표본. 실제 원고 이미지 이름이 한글이다. */
function sampleEntries(): ZipEntry[] {
  const binary = new Uint8Array(1024);
  for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 7) % 256;
  return [
    { name: "01-숏컷과-짙은-스모키-메이크업.jpg", data: binary },
    { name: "02-오프숄더 컷.png", data: new TextEncoder().encode("PNG-ish body\n") },
    { name: "03-빈파일.jpg", data: new Uint8Array(0) },
  ];
}

async function checkZip(dir: string, label: string, zip: Uint8Array, entries: ZipEntry[]): Promise<void> {
  const path = resolve(dir, `${label}.zip`);
  await writeFile(path, zip);

  execFileSync("unzip", ["-t", path], { stdio: "pipe" });

  const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
  assert(
    listing.length === entries.length && entries.every((e) => listing.includes(e.name)),
    `[${label}] 파일 목록이 다르다: ${JSON.stringify(listing)}`
  );

  for (const entry of entries) {
    const got = execFileSync("unzip", ["-p", path, entry.name], { maxBuffer: 1 << 24 });
    assert(
      got.length === entry.data.length && got.every((b, i) => b === entry.data[i]),
      `[${label}] "${entry.name}" 내용이 다르다 (${got.length}바이트 vs ${entry.data.length}바이트)`
    );
  }
  console.log(`✅ [${label}] ${entries.length}개 항목 - unzip -t 통과, 내용 일치`);
}

/** 뷰어 HTML에 인라인된 zipStore 사본을 떼어내 Node에서 실행할 수 있게 만든다. */
function extractInlinedZipStore(html: string): (files: ReadonlyArray<ZipEntry>) => Uint8Array {
  const start = html.indexOf("function zipStore(");
  assert(start >= 0, "뷰어 HTML에 zipStore가 인라인되지 않았다");

  // 중괄호 균형으로 함수 끝을 찾는다. 이 함수 안에는 중괄호가 든 문자열·정규식이 없다.
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert(end > start, "인라인된 zipStore의 끝을 찾지 못했다");

  const source = html.slice(start, end);
  // tsx(esbuild)가 끼워 넣는 헬퍼. 모듈 바깥에 있어 페이지엔 따라오지 않으므로 브라우저에서만
  // 죽는다 - zipStore.ts의 "중첩 함수 금지" 주석 참고.
  assert(!source.includes("__name"), "인라인된 zipStore가 __name 헬퍼를 참조한다 (중첩 함수를 없애야 한다)");
  return new Function(`${source}; return zipStore;`)() as (files: ReadonlyArray<ZipEntry>) => Uint8Array;
}

function manifestWithImages(): ManuscriptManifest {
  return {
    topics: [
      {
        jobId: "job-1",
        keyword: "박보영 숏컷 스모키 메이크업 파격 변신 화보",
        category: "entertainment",
        date: "2026-09-28",
        readyAt: "2026-09-28T14:55:31.022Z",
        manuscript: {
          title: "박보영 숏컷 화보",
          searchDescription: null,
          slug: null,
          shortName: "박보영 숏컷",
          tags: [],
          body: "도입 문단입니다.\n\n[IMAGE: 숏컷 박보영 — 웹 검색]\n",
          imagePrompts: ["숏컷 박보영"],
          images: [
            {
              index: 1,
              fileName: "01-숏컷과-짙은-스모키-메이크업.jpg",
              url: "https://example.supabase.co/storage/v1/object/public/article-images/job-1/1-web.jpg?v=abc",
              description: "숏컷과 짙은 스모키 메이크업",
              prompt: null,
              provider: "web",
            },
          ],
          filePath: "manuscripts/2026-09-28/박보영.md",
          naver: null,
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  console.log("▶ zipStore 테스트 시작\n");

  const dir = await mkdtemp(resolve(tmpdir(), "zip-store-"));
  try {
    const entries = sampleEntries();
    await checkZip(dir, "module", zipStore(entries), entries);

    const html = renderManuscriptPage(manifestWithImages(), new Date("2026-09-28T23:00:00Z"));
    const inlined = extractInlinedZipStore(html);
    await checkZip(dir, "inlined", inlined(entries), entries);

    // 버튼과 배선이 실제로 페이지에 들어갔는지. 둘 중 하나만 있으면 눌러도 아무 일이 없다.
    assert(html.includes('id="dl-images"'), "이미지 저장 버튼이 페이지에 없다");
    assert(html.includes("downloadImages(topic, dlBtn)"), "이미지 저장 버튼 클릭 배선이 없다");
    assert(html.includes('"박보영 숏컷"'), "zip 이름에 쓸 shortName이 페이지 데이터에 없다");
    console.log("✅ 뷰어 페이지에 버튼·배선·shortName이 모두 들어갔다");

    // 빈 zip도 깨지지 않아야 한다(이미지가 한 장도 없는 원고에서 눌렸을 때).
    const empty = zipStore([]);
    assert(empty.length === 22, `빈 zip은 EOCD 22바이트여야 한다 (실제: ${empty.length})`);
    console.log("✅ 빈 입력도 유효한 zip을 만든다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("\n✅ zipStore 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
