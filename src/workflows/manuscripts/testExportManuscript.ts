// exportManuscript 테스트. 네트워크 없이(fetchImage 주입) 임시 디렉터리에만 쓴다.
//
// MANUSCRIPT_EXPORT_ROOT를 import 전에 세팅해야 config/manuscriptExport.ts가 그 값을 읽는다 -
// 그래서 정적 import가 아니라 동적 import를 쓴다(사용자의 실제 보관함을 건드리지 않기 위한 가드).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "도입 문단입니다.",
  "[IMAGE: 카페 픽업대에 놓인 테이크아웃 음료 사진 — 웹 검색]",
  "**첫 소제목**\n소제목 문단입니다.",
  "[IMAGE: 종이컵에서 김이 나는 커피 일러스트 — AI 생성]",
  "마무리 문단입니다.",
].join("\n\n");

const PROMPTS = ["카페 테이크아웃 음료 픽업대", "A warm flat illustration of a paper coffee cup, no text. 16:9."];

/** 1×1 PNG. readImageSize가 헤더에서 크기를 읽어내는지 확인하는 데 쓴다. */
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function main(): Promise<void> {
  console.log("▶ exportManuscript 테스트 시작\n");

  const root = await mkdtemp(resolve(tmpdir(), "manuscript-export-"));
  process.env.MANUSCRIPT_EXPORT_ROOT = root;

  const { exportManuscript, readImageSize } = await import("./exportManuscript.js");
  const { exportFolderName } = await import("../../config/manuscriptExport.js");

  try {
    // 1) PNG 헤더에서 크기를 읽는다(사용자가 쓰던 image-metadata.md의 `크기:` 항목).
    const size = readImageSize(ONE_PX_PNG);
    assert(size?.width === 1 && size.height === 1, `PNG 크기를 읽어야 한다 (${JSON.stringify(size)})`);
    assert(readImageSize(Buffer.from("not an image")) === null, "못 읽는 형식은 null이어야 한다");
    console.log("✅ 이미지 크기 파싱(PNG) + 알 수 없는 형식 안전 처리");

    // 2) 폴더 이름은 한글 키워드 그대로 쓰되 경로에 위험한 문자만 걷어낸다.
    assert(exportFolderName("추석 앞두고 두쥐안 태풍 오나?") === "추석 앞두고 두쥐안 태풍 오나", "물음표는 빠져야 한다");
    assert(exportFolderName("a/b:c") === "a b c", `경로 구분자는 공백으로 (${exportFolderName("a/b:c")})`);
    assert(exportFolderName("   ") === "제목없음", "빈 이름은 폴백이 있어야 한다");
    console.log("✅ 폴더 이름 정규화(한글 유지, 경로 위험 문자 제거)");

    // 3) 내보내기 본체: AI 이미지만 받고, 웹 검색 자리는 "채울 자리"로 남는다.
    const topic = {
      jobId: "job-1",
      keyword: "남양주 카페 갑질",
      category: "community",
      date: "2026-09-16",
      readyAt: "2026-09-16T05:00:00Z",
      manuscript: {
        title: "남양주 카페 갑질 논란",
        searchDescription: "검색 설명",
        slug: "namyangju-cafe",
        tags: ["태그1"],
        body: BODY,
        imagePrompts: PROMPTS,
        images: [
          {
            index: 2,
            description: "종이컵에서 김이 나는 커피 일러스트 — AI 생성",
            prompt: PROMPTS[1],
            url: "https://storage/2.png",
            provider: "openai",
            fileName: "02-coffee-cup.png",
            error: null,
          },
        ],
        filePath: "manuscripts/2026-09-16/namyangju-cafe.md",
      },
    };

    const fetched: string[] = [];
    const result = await exportManuscript(topic, {
      fetchImage: async (url) => {
        fetched.push(url);
        return { ok: true, buffer: ONE_PX_PNG };
      },
    });

    assert(fetched.length === 1 && fetched[0] === "https://storage/2.png", `url 있는 이미지만 받아야 한다 (${JSON.stringify(fetched)})`);
    assert(result.downloaded === 1 && result.failures.length === 0, "1장 받고 실패 없어야 한다");
    assert(result.dir === resolve(root, "2026-09-16", "남양주 카페 갑질"), `폴더 경로가 <루트>/<날짜>/<한글 주제>여야 한다 (${result.dir})`);

    assert(result.slots.length === 2, `마커 2자리여야 한다 (${result.slots.length})`);
    assert(result.slots[0].acquisition === "search" && result.slots[0].fileNames.length === 0, "1번은 웹 검색 = 채울 자리");
    assert(result.slots[1].acquisition === "ai" && result.slots[1].fileNames[0] === "02-coffee-cup.png", "2번은 AI 생성 = 채워짐");
    console.log("✅ AI 이미지만 내려받고 웹 검색 자리는 비워 둠 + 폴더 경로 규칙");

    // 4) 원고 .md와 image-metadata.md가 실제로 쓰였고 내용이 맞는다.
    const manuscript = await readFile(result.manuscriptFile, "utf-8");
    assert(manuscript.includes("남양주 카페 갑질 논란") && manuscript.includes("도입 문단입니다."), "원고 제목과 본문이 들어가야 한다");
    assert(manuscript.includes("퍼머링크: namyangju-cafe"), "발행에 필요한 항목이 머리말에 있어야 한다");

    const metadata = await readFile(resolve(result.dir, "image-metadata.md"), "utf-8");
    assert(metadata.includes("## 02-coffee-cup.png"), "채워진 이미지는 파일명으로 항목이 서야 한다");
    assert(metadata.includes("- 크기: 1×1"), `헤더에서 읽은 크기가 들어가야 한다\n${metadata}`);
    assert(metadata.includes("생성 도구: openai"), "생성 도구가 기록돼야 한다");
    assert(metadata.includes("## 01 — 채울 자리"), "웹 검색 자리는 채울 자리로 남아야 한다");
    assert(metadata.includes(`검색어: ${PROMPTS[0]}`), "웹 검색 자리에는 검색어가 붙어야 한다");
    assert(!metadata.includes(`생성 프롬프트: ${PROMPTS[0]}`), "검색어를 생성 프롬프트로 적으면 안 된다");
    console.log("✅ 원고 .md + image-metadata.md 내용(채워진 자리/채울 자리 구분)");

    // 5) 이미 있는 파일은 건너뛰고, --force면 다시 받는다.
    const again = await exportManuscript(topic, { fetchImage: async () => ({ ok: true, buffer: ONE_PX_PNG }) });
    assert(again.downloaded === 0 && again.skipped === 1, `있는 파일은 건너뛰어야 한다 (${again.downloaded}/${again.skipped})`);

    const forced = await exportManuscript(topic, { force: true, fetchImage: async () => ({ ok: true, buffer: ONE_PX_PNG }) });
    assert(forced.downloaded === 1 && forced.skipped === 0, "--force면 다시 받아야 한다");
    console.log("✅ 중복 건너뛰기 + --force 재다운로드");

    // 6) 한 장이 실패해도 원고 파일은 쓰인다(best-effort - 나머지가 사라지면 안 된다).
    await rm(resolve(result.dir, "02-coffee-cup.png"));
    const failed = await exportManuscript(topic, { fetchImage: async () => ({ ok: false, error: "HTTP 404" }) });
    assert(failed.downloaded === 0 && failed.failures.length === 1, "실패 사유가 남아야 한다");
    assert(failed.failures[0].includes("HTTP 404"), `사유가 그대로 보여야 한다 (${failed.failures[0]})`);
    await readFile(failed.manuscriptFile, "utf-8");
    console.log("✅ 이미지 실패 격리 - 원고 파일은 그대로 쓰임");

    // 7) 보관함 밖으로 새어나가지 않는다(경로 조작 가드).
    const traversal = await exportManuscript(
      { ...topic, keyword: "../../탈출", manuscript: { ...topic.manuscript, images: [] } },
      { fetchImage: async () => ({ ok: true, buffer: ONE_PX_PNG }) }
    );
    assert(traversal.dir.startsWith(root), `보관함 루트 밖으로 나가면 안 된다 (${traversal.dir})`);
    console.log("✅ 키워드에 ../가 있어도 보관함 밖으로 나가지 않음");

    console.log("\n✅ exportManuscript 테스트 전체 통과");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
