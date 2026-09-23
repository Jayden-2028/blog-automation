// 클라우드 폴백 경고의 억제 규칙. 텔레그램·파일은 전부 주입해 가짜로 돌린다.

import { strict as assert } from "node:assert";

import { warnLocalFallback } from "./warnLocalFallback.js";

const tests: Array<[string, () => Promise<void>]> = [
  [
    "처음에는 알린다",
    async () => {
      const sent: string[] = [];
      let marked: number | null = null;
      await warnLocalFallback("research", "job-1", {
        notify: async (t) => {
          sent.push(t);
        },
        now: () => 1000,
        wasRecentlyAlerted: () => false,
        markAlerted: (at) => {
          marked = at;
        },
      });
      assert.equal(sent.length, 1);
      assert.ok(sent[0].includes("맥이 잠들면"), "무엇이 위험한지 말해야 한다");
      assert.ok(sent[0].includes("GITHUB_TOKEN"), "원인을 짚어야 한다");
      assert.ok(sent[0].includes("job-1"), "어느 job인지 알려야 한다");
      assert.equal(marked, 1000, "다음 알림을 조이려면 시각을 남겨야 한다");
    },
  ],
  [
    "최근에 알렸으면 조인다 - 소음이 되면 사람이 안 본다",
    async () => {
      const sent: string[] = [];
      let marked = false;
      await warnLocalFallback("write", "job-2", {
        notify: async (t) => {
          sent.push(t);
        },
        now: () => 2000,
        wasRecentlyAlerted: () => true,
        markAlerted: () => {
          marked = true;
        },
      });
      assert.deepEqual(sent, []);
      assert.equal(marked, false, "안 보냈으면 시각도 갱신하지 않는다");
    },
  ],
  [
    "단계에 따라 문구가 다르다",
    async () => {
      const sent: string[] = [];
      const deps = {
        notify: async (t: string) => {
          sent.push(t);
        },
        now: () => 1,
        wasRecentlyAlerted: () => false,
        markAlerted: () => {},
      };
      await warnLocalFallback("research", "j", deps);
      await warnLocalFallback("write", "j", deps);
      assert.ok(sent[0].includes("자료조사"), sent[0]);
      assert.ok(sent[1].includes("집필"), sent[1]);
    },
  ],
  [
    "한글 조사를 맞춘다 - 자료조사'를' / 집필'을'",
    async () => {
      // 기계적으로 "을"을 붙이면 "자료조사을"이 된다. 사용자가 매번 보는 문구다.
      const logs: string[] = [];
      const orig = console.warn;
      console.warn = (m: string) => logs.push(m);
      try {
        const deps = { notify: async () => {}, now: () => 1, wasRecentlyAlerted: () => true, markAlerted: () => {} };
        await warnLocalFallback("research", "j", deps);
        await warnLocalFallback("write", "j", deps);
      } finally {
        console.warn = orig;
      }
      assert.ok(logs[0].includes("자료조사를"), logs[0]);
      assert.ok(logs[1].includes("집필을"), logs[1]);
    },
  ],
  [
    "알림이 던져도 파이프라인을 막지 않는다",
    async () => {
      // 여기서 던지면 알림 하나 때문에 조사가 발화되지 않는다 - 더 나쁜 상황이다.
      await warnLocalFallback("research", "job-3", {
        notify: async () => {
          throw new Error("텔레그램 죽음");
        },
        now: () => 1,
        wasRecentlyAlerted: () => false,
        markAlerted: () => {},
      });
    },
  ],
  [
    "마커를 못 써도 던지지 않는다",
    async () => {
      await warnLocalFallback("write", "job-4", {
        notify: async () => {},
        now: () => 1,
        wasRecentlyAlerted: () => false,
        markAlerted: () => {
          throw new Error("디스크 없음");
        },
      });
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
console.log("\n🎉 클라우드 폴백 경고 테스트 통과");
