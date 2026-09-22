// 리버스 이미지 검색(2-b)의 결과 해석과 폴백 규칙. 브라우저는 주입해 가짜로 돌린다 -
// lens.google.com은 CAPTCHA를 띄우므로 테스트에서 실제로 부르면 안 된다.

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeEntities, extractHits, parseOgImage, resolveHits, reverseImageSearch } from "./reverseImageSearch.js";
import type { ReverseSearchResult } from "./reverseImageSearch.js";
import { findCleanAlternative } from "./findCleanAlternative.js";

function row(patch: Partial<{ href: string; text: string }> = {}) {
  return { href: "https://news.test/article/1", text: "기사 제목", ...patch };
}

const OG = '<html><head><meta property="og:image" content="https://news.test/photo.jpg"></head></html>';

const tests: Array<[string, () => Promise<void>]> = [
  [
    "구글 자체 링크는 출처 페이지가 못 된다",
    () => {
      const out = extractHits([
        row({ href: "https://www.google.com/search?q=x" }),
        row({ href: "https://policies.google.co.kr/terms" }),
        row({ href: "https://lh3.googleusercontent.com/abc" }),
        row({ href: "https://news.test/article/1" }),
      ]);
      assert.equal(out.length, 1);
      assert.equal(out[0].sourcePage, "https://news.test/article/1");
      return Promise.resolve();
    },
  ],
  [
    "같은 출처 페이지는 한 번만 쓴다",
    () => {
      assert.equal(extractHits([row(), row(), row({ href: "https://other.test/2" })]).length, 2);
      return Promise.resolve();
    },
  ],
  [
    "인스타 출처는 페이지를 받아보지도 않는다",
    () => {
      assert.deepEqual(extractHits([row({ href: "https://www.instagram.com/p/X/" })]), []);
      return Promise.resolve();
    },
  ],
  [
    "og:image에서 실제 이미지를 뽑는다 - 렌즈 썸네일은 205px라 못 쓴다",
    async () => {
      assert.equal(parseOgImage(OG, "https://news.test/a"), "https://news.test/photo.jpg");
      assert.equal(
        parseOgImage('<meta property="og:image" content="/rel/p.jpg">', "https://news.test/a/b"),
        "https://news.test/rel/p.jpg",
        "상대 경로를 절대 주소로 만들어야 한다"
      );
      assert.equal(
        parseOgImage('<meta name="twitter:image" content="https://news.test/t.jpg">', "https://news.test/a"),
        "https://news.test/t.jpg",
        "og:image가 없으면 twitter:image"
      );
      assert.equal(parseOgImage("<html><head></head></html>", "https://news.test/a"), null);
    },
  ],
  [
    "og:image의 &amp;를 풀지 않으면 받을 때 404다",
    async () => {
      // 2026-09-23 실측: X(트위터) og:image가 ?format=webp&amp;name=large로 나와 그대로 받으면
      // 404였다. 렌즈가 정확히 찾아줘도 여기서 새면 후보가 통째로 버려진다.
      assert.equal(
        parseOgImage(
          '<meta property="og:image" content="https://pbs.twimg.com/media/X?format=webp&amp;name=large">',
          "https://x.com/a/1"
        ),
        "https://pbs.twimg.com/media/X?format=webp&name=large"
      );
      assert.equal(decodeEntities("a&amp;b&#38;c"), "a&b&c");
    },
  ],
  [
    "og:image가 없는 페이지는 그 후보만 버린다",
    async () => {
      const out = await resolveHits(
        [
          { sourcePage: "https://news.test/1", title: "없음" },
          { sourcePage: "https://news.test/2", title: "있음" },
        ],
        async (url) => (url.endsWith("/2") ? OG : "<html></html>")
      );
      assert.equal(out.length, 1);
      assert.equal(out[0].sourcePage, "https://news.test/2");
      assert.equal(out[0].link, "https://news.test/photo.jpg");
    },
  ],
  [
    "꺼져 있으면 브라우저를 아예 안 띄운다",
    async () => {
      delete process.env.LENS_REVERSE_SEARCH;
      let called = false;
      const r = await reverseImageSearch("/tmp/slide.png", {
        collect: async () => {
          called = true;
          return [];
        },
      });
      assert.equal(r.status, "skipped");
      assert.equal(called, false, "꺼져 있는데 브라우저를 띄우면 매 분 헛돈다");
    },
  ],
  [
    "켜져 있어도 프로필이 없으면 건너뛴다",
    async () => {
      process.env.LENS_REVERSE_SEARCH = "true";
      delete process.env.LENS_BROWSER_PROFILE;
      const r = await reverseImageSearch("/tmp/slide.png", { collect: async () => [] });
      assert.equal(r.status, "skipped");
      if (r.status !== "skipped") return;
      assert.ok(r.reason.includes("LENS_BROWSER_PROFILE"), r.reason);
    },
  ],
  [
    "렌즈가 찾으면 그 후보를 쓰고 텍스트 검색은 아예 안 돈다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rev-ok-"));
      try {
        let searched = false;
        const found = await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir, slidePath: "/tmp/slide.png" },
          {
            reverseSearch: async (): Promise<ReverseSearchResult> => ({
              status: "ok",
              candidates: [
                {
                  title: "기사",
                  link: "https://news.test/photo.jpg",
                  thumbnail: "",
                  width: 900,
                  height: 700,
                  sourcePage: "https://news.test/article/1",
                },
              ],
            }),
            search: async () => {
              searched = true;
              return [];
            },
            fetchImage: async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }),
          }
        );
        assert.ok(found, "렌즈 후보를 써야 한다");
        assert.equal(found?.sourcePage, "https://news.test/article/1");
        assert.ok(found?.note?.includes("렌즈"), "어느 경로로 찾았는지 승인 단계에서 보여야 한다");
        assert.equal(searched, false, "렌즈가 찾았으면 텍스트 검색은 낭비다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "렌즈가 CAPTCHA로 막히면 텍스트 검색으로 떨어진다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rev-blocked-"));
      try {
        let searched = false;
        const found = await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir, slidePath: "/tmp/slide.png" },
          {
            reverseSearch: async (): Promise<ReverseSearchResult> => ({ status: "blocked" }),
            search: async () => {
              searched = true;
              return [
                {
                  title: "기사",
                  link: "https://news.test/b.jpg",
                  thumbnail: "",
                  width: 900,
                  height: 700,
                  sourcePage: "https://news.test/2",
                },
              ];
            },
            fetchImage: async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }),
          }
        );
        assert.equal(searched, true, "막혔다고 대체 이미지를 통째로 포기하면 안 된다");
        assert.ok(found, "폴백으로라도 후보를 내야 한다");
        assert.ok(found?.note?.includes("검색어"), "텍스트 검색 경로임을 적어야 한다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "리버스 검색이 던져도 파이프라인은 안 멈춘다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rev-throw-"));
      try {
        const found = await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir, slidePath: "/tmp/slide.png" },
          {
            reverseSearch: async () => {
              throw new Error("브라우저 실행 실패");
            },
            search: async () => [
              { title: "기사", link: "https://news.test/c.jpg", thumbnail: "", width: 900, height: 700, sourcePage: "https://news.test/3" },
            ],
            fetchImage: async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }),
          }
        );
        assert.ok(found, "예외를 그대로 올리면 슬라이드 하나 때문에 캡처 전체가 실패한다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "slidePath가 없으면 리버스 검색을 시도하지 않는다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rev-nopath-"));
      try {
        let reversed = false;
        await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir },
          {
            reverseSearch: async () => {
              reversed = true;
              return { status: "ok", candidates: [] };
            },
            search: async () => [],
            fetchImage: async () => null,
          }
        );
        assert.equal(reversed, false);
        assert.deepEqual(await readdir(dir), []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "렌즈 결과도 인스타 도메인은 뺀다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rev-ig-"));
      try {
        let searched = false;
        await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir, slidePath: "/tmp/slide.png" },
          {
            reverseSearch: async (): Promise<ReverseSearchResult> => ({
              status: "ok",
              candidates: [
                {
                  title: "인스타",
                  link: "https://scontent.cdninstagram.com/a.jpg",
                  thumbnail: "",
                  width: 900,
                  height: 700,
                  sourcePage: "https://www.instagram.com/p/X/",
                },
              ],
            }),
            search: async () => {
              searched = true;
              return [];
            },
            fetchImage: async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }),
          }
        );
        assert.equal(searched, true, "렌즈 후보가 전부 인스타면 텍스트 검색으로 가야 한다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
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
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 리버스 이미지 검색 테스트 통과");
