// 캡처 세션 오케스트레이션 불변식. 브라우저·모델은 가짜를 넣어 **정책과 실패 처리**만 검증한다
// (실제 인스타 접속은 맥에서만 되므로 여기서 다루지 않는다).

import { strict as assert } from "node:assert";

import { runCaptureSession } from "./runCaptureSession.js";
import type { CleanAlternative, RunCaptureSessionDeps } from "./runCaptureSession.js";
import type { CarouselCapture, CarouselJudgement } from "./captureTypes.js";
import type { InstagramQueueEntry } from "./types.js";

function entry(patch: Partial<InstagramQueueEntry> = {}): InstagramQueueEntry {
  return {
    id: "42",
    instagramUrl: "https://www.instagram.com/p/abc/",
    rawCaption: "",
    telegramChatId: "1",
    telegramMessageId: 1,
    receivedAt: "2026-09-22T00:00:00Z",
    status: "pending",
    ...patch,
  };
}

function deps(over: Partial<RunCaptureSessionDeps> = {}, log?: string[]): RunCaptureSessionDeps {
  const capture: CarouselCapture = {
    slides: [
      { slideIndex: 1, localPath: "/tmp/s1.png" },
      { slideIndex: 2, localPath: "/tmp/s2.png" },
    ],
    caption: "게시물에서 긁은 캡션",
    tempDir: "/tmp/ig-xyz",
  };
  const judgement: CarouselJudgement = {
    searchKeyword: "김지원 밀라노",
    category: "entertainment",
    slides: [
      { slideIndex: 1, hasOverlay: false, burnedInText: "", description: "레드카펫 전신샷" },
      { slideIndex: 2, hasOverlay: true, burnedInText: "9월 24일 밀라노", description: "행사 안내 카드" },
    ],
  };
  return {
    capture: async () => capture,
    judge: async () => judgement,
    findCleanAlternative: async (): Promise<CleanAlternative | null> => ({
      localPath: "/tmp/alt.jpg",
      sourcePage: "https://news.test/1",
    }),
    cleanup: async (dir) => {
      log?.push(`cleanup:${dir}`);
    },
    ...over,
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "오버레이 없는 슬라이드는 그대로, 있는 슬라이드는 대체 이미지로",
    async () => {
      const r = await runCaptureSession(entry(), deps());
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.deepEqual(
        r.capture.images.map((i) => [i.slideIndex, i.kind]),
        [
          [1, "instagram_capture"],
          [2, "web_alternative"],
        ]
      );
      assert.equal(r.capture.images[1].sourcePage, "https://news.test/1");
    },
  ],
  [
    "번인 텍스트는 이미지를 못 써도 남는다",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({ findCleanAlternative: async () => null })   // 대체 이미지를 못 찾음
      );
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.capture.images.length, 1, "자리 2는 버려져야 한다");
      assert.equal(r.slidesDropped, 1);
      assert.deepEqual(r.capture.burnedInText, ["9월 24일 밀라노"], "번인 텍스트는 살아남아야 한다");
    },
  ],
  [
    "슬라이드 0장이면 job을 만들지 않는다",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({ capture: async () => ({ slides: [], caption: "", tempDir: "/tmp/x" }) })
      );
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.ok(r.error.includes("슬라이드"), r.error);
    },
  ],
  [
    "판정이 없는 슬라이드는 안전한 쪽(오버레이 있음)으로 본다",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({
          judge: async () => ({
            searchKeyword: "주제",
            category: null,
            slides: [{ slideIndex: 1, hasOverlay: false, burnedInText: "", description: "" }],
            // 슬라이드 2에 대한 판정이 없다
          }),
        })
      );
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.capture.images[1].kind, "web_alternative", "판정 없는 슬라이드를 그대로 쓰면 안 된다");
    },
  ],
  [
    "사람이 붙여넣은 캡션이 게시물 캡션보다 우선한다",
    async () => {
      const r = await runCaptureSession(entry({ rawCaption: "사람이 쓴 캡션" }), deps());
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.capture.caption, "사람이 쓴 캡션");

      const r2 = await runCaptureSession(entry({ rawCaption: "   " }), deps());
      if (r2.status !== "ready") return;
      assert.equal(r2.capture.caption, "게시물에서 긁은 캡션", "비어 있으면 게시물 캡션으로 떨어진다");
    },
  ],
  [
    "주제어를 못 뽑으면 실패한다",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({ judge: async () => ({ searchKeyword: "  ", category: null, slides: [] }) })
      );
      assert.equal(r.status, "failed");
    },
  ],
  [
    "브라우저가 던져도 예외가 새지 않고 실패로 돌아온다",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({
          capture: async () => {
            throw new Error("로그인 페이지로 튕겼습니다");
          },
        })
      );
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.ok(r.error.includes("로그인"), r.error);
    },
  ],
  [
    "성공하면 정리하지 않고 tempDir를 넘긴다 - 이미지를 아직 안 읽었다",
    async () => {
      // 2026-09-23 회귀: 여기서 지우면 createInstagramJob이 읽을 때 파일이 없어
      // 이미지 0장짜리 job이 조용히 만들어졌다. 정리는 호출자가 job을 만든 뒤에 한다.
      const okLog: string[] = [];
      const r = await runCaptureSession(entry(), deps({}, okLog));
      assert.deepEqual(okLog, [], "성공했는데 정리하면 이미지를 잃는다");
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.tempDir, "/tmp/ig-xyz", "호출자가 지울 수 있게 경로를 넘겨야 한다");
    },
  ],
  [
    "실패하면 그 자리에서 임시 디렉터리를 정리한다",
    async () => {
      const failLog: string[] = [];
      await runCaptureSession(
        entry(),
        deps(
          {
            judge: async () => {
              throw new Error("모델 실패");
            },
          },
          failLog
        )
      );
      assert.deepEqual(failLog, ["cleanup:/tmp/ig-xyz"], "실패해도 정리해야 한다");
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
  console.error(`\n❌ 캡처 세션 테스트 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 캡처 세션 테스트 통과");
