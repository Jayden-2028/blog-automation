// 리버스 이미지 검색(2-b)의 후보 선별·해시 비교·폴백 규칙. 브라우저는 주입해 가짜로 돌린다 -
// lens.google.com을 테스트에서 실제로 부르면 CAPTCHA를 맞고 계정도 위험해진다.

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MATCH_MAX_DISTANCE,
  decodeEntities,
  extractHits,
  hammingHex,
  pickPageImages,
  reverseImageSearch,
} from "./reverseImageSearch.js";
import type { MatchedCandidate, ReverseSearchResult } from "./reverseImageSearch.js";
import { findCleanAlternative } from "./findCleanAlternative.js";

const THUMB = "data:image/jpeg;base64,AAAA";

function card(patch: Partial<{ href: string; title: string; thumbnail: string }> = {}) {
  return { href: "https://news.test/article/1", title: "기사 제목", thumbnail: THUMB, ...patch };
}

function matched(patch: Partial<MatchedCandidate> = {}): MatchedCandidate {
  return {
    title: "기사",
    link: "https://news.test/photo.jpg",
    thumbnail: "https://news.test/photo.jpg",
    width: null,
    height: null,
    sourcePage: "https://news.test/article/1",
    matchDistance: 2,
    ...patch,
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "구글 자체 링크는 출처 페이지가 못 된다",
    () => {
      const out = extractHits([
        card({ href: "https://www.google.com/search?q=x" }),
        card({ href: "https://policies.google.co.kr/terms" }),
        card({ href: "https://lh3.googleusercontent.com/abc" }),
        card({ href: "https://news.test/article/1" }),
      ]);
      assert.equal(out.length, 1);
      assert.equal(out[0].sourcePage, "https://news.test/article/1");
      return Promise.resolve();
    },
  ],
  [
    "같은 출처 페이지는 한 번만 쓴다",
    () => {
      assert.equal(extractHits([card(), card(), card({ href: "https://other.test/2" })]).length, 2);
      return Promise.resolve();
    },
  ],
  [
    "인스타 출처는 페이지를 받아보지도 않는다",
    () => {
      assert.deepEqual(extractHits([card({ href: "https://www.instagram.com/p/X/" })]), []);
      return Promise.resolve();
    },
  ],
  [
    "썸네일이 없는 카드는 기준이 없어 버린다",
    () => {
      // 썸네일이 해시 비교의 기준이다. 없으면 "같은 사진인지"를 판정할 근거가 없다.
      assert.deepEqual(extractHits([card({ thumbnail: "" })]), []);
      assert.deepEqual(extractHits([card({ thumbnail: "https://x.test/a.jpg" })]), [], "원격 주소는 기준이 아니다");
      return Promise.resolve();
    },
  ],
  [
    "해밍 거리 - 같으면 0, 한 비트만 다르면 1",
    () => {
      assert.equal(hammingHex("0000000000000000", "0000000000000000"), 0);
      assert.equal(hammingHex("0000000000000000", "0000000000000001"), 1);
      assert.equal(hammingHex("ffffffffffffffff", "0000000000000000"), 64);
      assert.equal(hammingHex("abc", "abcd"), Number.MAX_SAFE_INTEGER, "길이가 다르면 비교 불가");
      assert.equal(hammingHex("zzzz", "0000"), Number.MAX_SAFE_INTEGER, "16진수가 아니면 비교 불가");
      return Promise.resolve();
    },
  ],
  [
    "출처 페이지 이미지 후보 - og:image가 먼저, 본문 img가 뒤",
    () => {
      const html = `<html><head>
        <meta property="og:image" content="https://news.test/og.jpg">
        </head><body>
        <img src="/body-1.jpg"><img data-src="https://news.test/body-2.jpg">
        <img src="https://scontent.cdninstagram.com/x.jpg">
        <img src="data:image/gif;base64,AAA">
        </body></html>`;
      const out = pickPageImages(html, "https://news.test/a/b");
      assert.equal(out[0], "https://news.test/og.jpg", "대표 이미지를 먼저 본다");
      assert.ok(out.includes("https://news.test/body-1.jpg"), "상대 경로를 절대 주소로");
      assert.ok(out.includes("https://news.test/body-2.jpg"), "data-src도 본다");
      assert.ok(!out.some((u) => u.includes("cdninstagram")), "인스타 이미지는 여기서도 뺀다");
      assert.ok(!out.some((u) => u.startsWith("data:")), "data: URI는 받을 대상이 아니다");
      return Promise.resolve();
    },
  ],
  [
    "og:image의 &amp;를 풀지 않으면 받을 때 404다",
    () => {
      // 2026-09-23 실측: X(트위터) og:image가 ?format=webp&amp;name=large로 나왔다.
      const out = pickPageImages(
        '<meta property="og:image" content="https://pbs.twimg.com/media/X?format=webp&amp;name=large">',
        "https://x.com/a/1"
      );
      assert.equal(out[0], "https://pbs.twimg.com/media/X?format=webp&name=large");
      assert.equal(decodeEntities("a&amp;b&#38;c"), "a&b&c");
      return Promise.resolve();
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
    "collect가 던지면 failed로 감싼다 - 호출자가 이유를 로그에 남긴다",
    async () => {
      process.env.LENS_REVERSE_SEARCH = "true";
      process.env.LENS_BROWSER_PROFILE = "/tmp/lens-profile";
      const r = await reverseImageSearch("/tmp/slide.png", {
        collect: async () => {
          throw new Error("크롬 실행 실패");
        },
      });
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.ok(r.error.includes("크롬"), r.error);
    },
  ],
  [
    "해시가 맞은 후보를 쓰고, note에 거리를 적는다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rev-ok-"));
      try {
        let searched = false;
        const found = await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir, slidePath: "/tmp/slide.png" },
          {
            reverseSearch: async (): Promise<ReverseSearchResult> => ({
              status: "ok",
              candidates: [matched({ matchDistance: 3 })],
            }),
            search: async () => {
              searched = true;
              return [];
            },
            fetchImage: async () => ({ buffer: Buffer.from("x"), contentType: "image/jpeg" }),
          }
        );
        assert.ok(found);
        assert.equal(found?.sourcePage, "https://news.test/article/1");
        assert.ok(found?.note?.includes("같은 사진"), "해시로 대조했으니 근거가 있다");
        assert.ok(found?.note?.includes(`3/${MATCH_MAX_DISTANCE}`), `거리를 적어야 한다: ${found?.note}`);
        assert.equal(searched, false, "렌즈가 찾았으면 텍스트 검색은 낭비다");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    "해시가 안 맞아 후보가 0개면 텍스트 검색으로 떨어진다",
    async () => {
      // 같은 사진을 찾는 것이 2-b의 존재 이유다. 못 찾으면 비슷한 것을 억지로 내지 않고
      // 2-a에 넘긴다 - 그쪽은 "같은 사진이 아닐 수 있음"이라고 정직하게 적는다.
      const dir = await mkdtemp(join(tmpdir(), "rev-nomatch-"));
      try {
        let searched = false;
        const found = await findCleanAlternative(
          { keyword: "주제어", description: "설명", slideIndex: 1, tempDir: dir, slidePath: "/tmp/slide.png" },
          {
            reverseSearch: async (): Promise<ReverseSearchResult> => ({ status: "ok", candidates: [] }),
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
        assert.equal(searched, true);
        assert.ok(found?.note?.includes("같은 사진이 아닐 수 있음"), found?.note ?? "note 없음");
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
        await findCleanAlternative(
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
              {
                title: "기사",
                link: "https://news.test/c.jpg",
                thumbnail: "",
                width: 900,
                height: 700,
                sourcePage: "https://news.test/3",
              },
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
                matched({
                  link: "https://scontent.cdninstagram.com/a.jpg",
                  sourcePage: "https://www.instagram.com/p/X/",
                }),
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
