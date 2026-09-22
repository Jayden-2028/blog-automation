// 대체 이미지 소싱 규격. 검색·다운로드는 가짜를 넣는다(실제 네트워크를 타지 않는다).

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAlternativeQuery,
  extensionForContentType,
  findCleanAlternative,
  isBlockedSource,
} from "./findCleanAlternative.js";
import type { Downloaded } from "./findCleanAlternative.js";
import type { ImageCandidate } from "../images/searchNaverImages.js";

function candidate(patch: Partial<ImageCandidate> = {}): ImageCandidate {
  return { title: "제목", link: "https://img.test/a.jpg", thumbnail: "", width: 800, height: 600, ...patch };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "인스타 도메인은 대체 이미지 후보에서 뺀다",
    () => {
      // 2026-09-23: 실측에서 대체 이미지의 출처가 또 다른 인스타 게시물이었다(job ec21f085).
      // 오버레이 없는 깨끗한 원본을 찾는 게 목적인데 같은 플랫폼의 다른 뉴스 카드를 물어오면
      // 목적이 무너지고, 저작권 판단도 원본과 다를 바 없다.
      assert.equal(isBlockedSource({ link: "https://scontent-xxx.cdninstagram.com/a.jpg" }), true);
      assert.equal(
        isBlockedSource({ link: "https://img.test/a.jpg", sourcePage: "https://www.instagram.com/p/AbC/" }),
        true,
        "이미지가 밖에 있어도 출처가 인스타면 뺀다"
      );
      assert.equal(isBlockedSource({ link: "https://x.fbcdn.net/a.jpg" }), true, "인스타 CDN");
      assert.equal(isBlockedSource({ link: "https://www.threads.net/@a/post/1" }), true);
      assert.equal(
        isBlockedSource({ link: "https://imgnews.naver.net/a.jpg", sourcePage: "https://n.news.naver.com/1" }),
        false,
        "언론사는 그대로 쓴다"
      );
      assert.equal(
        isBlockedSource({ link: "https://notinstagram.com/a.jpg" }),
        false,
        "도메인 끝만 같은 다른 사이트를 오인하면 안 된다"
      );
      return Promise.resolve();
    },
  ],
  [
    "검색 결과에 인스타만 있으면 대체 이미지를 포기한다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-blocked-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir },
          {
            search: async () => [
              candidate({ link: "https://scontent.cdninstagram.com/a.jpg" }),
              candidate({ link: "https://img.test/b.jpg", sourcePage: "https://www.instagram.com/p/X/" }),
            ],
            fetchImage: async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }),
          }
        );
        assert.equal(found, null, "인스타뿐이면 자리를 비우는 게 맞다 - 엉뚱한 출처를 남기지 않는다");
        assert.deepEqual(await readdir(dir), [], "받지도 않아야 한다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "content-type으로 확장자를 정한다",
    () => {
      // .img로 두면 createInstagramJob의 guessMimeType이 전부 image/png로 읽어,
      // 내용은 JPEG인데 png라고 적힌 파일이 Storage에 올라간다.
      assert.equal(extensionForContentType("image/jpeg"), "jpg");
      assert.equal(extensionForContentType("image/jpeg; charset=utf-8"), "jpg");
      assert.equal(extensionForContentType("IMAGE/WEBP"), "webp");
      assert.equal(extensionForContentType("image/gif"), "gif");
      assert.equal(extensionForContentType(""), "png");
      return Promise.resolve();
    },
  ],
  [
    "내려받은 파일은 넘겨받은 tempDir에 쓴다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제", description: "설명", slideIndex: 3, tempDir: dir },
          {
            search: async () => [candidate()],
            fetchImage: async (): Promise<Downloaded> => ({ buffer: Buffer.from("xx"), contentType: "image/jpeg" }),
          }
        );
        assert.ok(found);
        assert.equal(found.localPath, join(dir, "alt-3.jpg"));
        assert.deepEqual(await readdir(dir), ["alt-3.jpg"]);
        assert.equal((await readFile(found.localPath)).toString(), "xx");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "앞 후보가 막히면 다음 후보로 넘어간다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        let call = 0;
        const found = await findCleanAlternative(
          { keyword: "주제", description: "", slideIndex: 1, tempDir: dir },
          {
            search: async () => [candidate({ link: "https://a.test/1.jpg" }), candidate({ link: "https://b.test/2.jpg" })],
            fetchImage: async () => {
              call += 1;
              return call === 1 ? null : { buffer: Buffer.from("ok"), contentType: "image/png" };
            },
          }
        );
        assert.ok(found, "첫 후보가 막혔다고 자리를 버리면 안 된다");
        assert.equal(call, 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "너무 작은 후보는 거르고, 크기를 모르는 후보는 남긴다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        const seen: string[] = [];
        await findCleanAlternative(
          { keyword: "주제", description: "", slideIndex: 1, tempDir: dir },
          {
            search: async () => [
              candidate({ link: "https://small.test/x.jpg", width: 100, height: 100 }),
              candidate({ link: "https://unknown.test/y.jpg", width: null, height: null }),
            ],
            fetchImage: async (url) => {
              seen.push(url);
              return { buffer: Buffer.from("ok"), contentType: "image/png" };
            },
          }
        );
        assert.deepEqual(seen, ["https://unknown.test/y.jpg"], "작은 건 빼고 크기 미상은 시도해야 한다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "하나도 못 받으면 null (자리를 비운다)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제", description: "", slideIndex: 1, tempDir: dir },
          { search: async () => [candidate()], fetchImage: async () => null }
        );
        assert.equal(found, null);
        assert.deepEqual(await readdir(dir), [], "실패했으면 파일도 안 남아야 한다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "검색이 던져도 자리만 비우고 넘어간다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제", description: "", slideIndex: 1, tempDir: dir },
          {
            search: async () => {
              throw new Error("Serper 크레딧 소진");
            },
          }
        );
        assert.equal(found, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "출처 페이지가 있는 후보를 먼저 쓴다",
    async () => {
      // 네이버는 sourcePage를 안 준다. 폴백이 이미지 파일 URL을 출처로 남기면 사람이 열어
      // 저작권을 판단할 페이지가 사라진다(2026-09-22 실측: imgnews.naver.net/....jpg).
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제", description: "", slideIndex: 1, tempDir: dir },
          {
            search: async () => [
              candidate({ link: "https://naver.test/a.jpg", sourcePage: null }),
              candidate({ link: "https://google.test/b.jpg", sourcePage: "https://news.test/article" }),
            ],
            fetchImage: async (): Promise<Downloaded> => ({ buffer: Buffer.from("ok"), contentType: "image/jpeg" }),
          }
        );
        assert.equal(found?.sourcePage, "https://news.test/article", "출처 있는 쪽이 먼저여야 한다");
        assert.ok(!found?.note?.includes("출처 페이지 불명"));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "출처를 끝내 못 구하면 note에 그 사실을 적는다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "alt-test-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제", description: "", slideIndex: 1, tempDir: dir },
          {
            search: async () => [candidate({ link: "https://naver.test/a.jpg", sourcePage: null })],
            fetchImage: async (): Promise<Downloaded> => ({ buffer: Buffer.from("ok"), contentType: "image/jpeg" }),
          }
        );
        assert.ok(found);
        assert.ok(found.note?.includes("출처 페이지 불명"), `승인 단계에서 알아야 한다: ${found.note}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "검색어는 주제어 + 짧은 설명 (수식이 길면 0건으로 끝난다)",
    () => {
      assert.equal(buildAlternativeQuery("김지원", "레드카펫 전신샷"), "김지원 레드카펫 전신샷");
      assert.equal(buildAlternativeQuery("김지원", "   "), "김지원");
      assert.equal(
        buildAlternativeQuery("김지원", "아주 긴 설명 이 여기 계속 이어지고 더 있다 훨씬"),
        "김지원 아주 긴 설명 이 여기 계속"
      );
      return Promise.resolve();
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error instanceof Error ? error.message : error}`);
  }
}

if (failed > 0) {
  console.error(`\n❌ 대체 이미지 테스트 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 대체 이미지 테스트 통과");
