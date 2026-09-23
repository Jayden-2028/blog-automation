// 게시물 1건을 읽는 순서와 빈 자료 판정. 브라우저·모델은 전부 주입해 가짜로 돌린다.

import { strict as assert } from "node:assert";

import { runCaptureSession } from "./runCaptureSession.js";
import type { RunCaptureSessionDeps } from "./runCaptureSession.js";
import type { CarouselCapture, CarouselJudgement } from "./captureTypes.js";
import type { InstagramQueueEntry } from "./types.js";

function entry(patch: Partial<InstagramQueueEntry> = {}): InstagramQueueEntry {
  return {
    id: "42",
    instagramUrl: "https://www.instagram.com/p/abc/",
    rawCaption: "",
    telegramChatId: "1",
    telegramMessageId: 1,
    receivedAt: "2026-09-23T00:00:00Z",
    status: "pending",
    ...patch,
  };
}

const CAPTURE: CarouselCapture = {
  slides: [
    { slideIndex: 1, localPath: "/tmp/ig-xyz/slide-1.png" },
    { slideIndex: 2, localPath: "/tmp/ig-xyz/slide-2.png" },
  ],
  caption: 'focuspic.kr - September 9, 2026: "허진호 감독의 영화 <암살자(들)>이 개봉합니다."',
  tempDir: "/tmp/ig-xyz",
};

const JUDGEMENT: CarouselJudgement = {
  searchKeyword: "암살자들 개봉",
  category: "entertainment",
  slides: [
    { slideIndex: 1, burnedInText: "9월 개봉 <암살자(들)>" },
    { slideIndex: 2, burnedInText: "  " },
  ],
};

function deps(patch: Partial<RunCaptureSessionDeps> = {}, log?: string[]): RunCaptureSessionDeps {
  return {
    capture: async () => CAPTURE,
    judge: async () => JUDGEMENT,
    cleanup: async (dir) => {
      log?.push(`cleanup:${dir}`);
    },
    ...patch,
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "캡션과 번인 텍스트를 모아 준다 - 빈 번인은 버린다",
    async () => {
      const r = await runCaptureSession(entry(), deps());
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.capture.searchKeyword, "암살자들 개봉");
      assert.equal(r.capture.category, "entertainment");
      assert.deepEqual(r.capture.burnedInText, ["9월 개봉 <암살자(들)>"], "공백뿐인 번인은 버린다");
      assert.equal(r.slidesRead, 2);
    },
  ],
  [
    "캡션의 군더더기(계정·날짜·따옴표)를 벗긴다",
    async () => {
      const r = await runCaptureSession(entry(), deps());
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.capture.caption, "허진호 감독의 영화 <암살자(들)>이 개봉합니다.");
    },
  ],
  [
    "결과에 이미지가 없다 - 게시물 사진은 쓰지 않는다",
    async () => {
      const r = await runCaptureSession(entry(), deps());
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.ok(!("images" in r.capture), "이미지 필드가 남아 있으면 옛 설계가 되살아난 것이다");
    },
  ],
  [
    "슬라이드 0장이어도 캡션이 있으면 진행한다",
    async () => {
      // 2026-09-23 사용자 결정: 캡션은 og:description으로 따로 오므로 슬라이드가 깨져도 살아 있다.
      let judged = false;
      const r = await runCaptureSession(
        entry(),
        deps({
          capture: async () => ({ ...CAPTURE, slides: [] }),
          judge: async () => {
            judged = true;
            return JUDGEMENT;
          },
        })
      );
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(judged, false, "슬라이드가 없으면 모델을 부르지 않는다 - 볼 게 없다");
      assert.deepEqual(r.capture.burnedInText, []);
      assert.ok(r.capture.searchKeyword.length > 0, "주제어는 캡션 첫 줄로 대신한다");
    },
  ],
  [
    "캡션도 번인도 없으면 no_material - 주제어를 지어내지 않는다",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({
          capture: async () => ({ ...CAPTURE, slides: [], caption: "" }),
        })
      );
      assert.equal(r.status, "no_material");
      if (r.status !== "no_material") return;
      assert.equal(r.instagramUrl, "https://www.instagram.com/p/abc/");
    },
  ],
  [
    "사용자가 보낸 캡션이 있으면 게시물이 비어도 그걸 쓴다",
    async () => {
      const r = await runCaptureSession(
        entry({ rawCaption: "이나영 신작 출연" }),
        deps({ capture: async () => ({ ...CAPTURE, slides: [], caption: "" }) })
      );
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.capture.caption, "이나영 신작 출연");
    },
  ],
  [
    "캡처가 던지면 failed",
    async () => {
      const r = await runCaptureSession(
        entry(),
        deps({
          capture: async () => {
            throw new Error("로그인 벽");
          },
        })
      );
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.ok(r.error.includes("로그인"), r.error);
    },
  ],
  [
    "성공이든 실패든 임시 디렉터리를 정리한다",
    async () => {
      // 결과가 파일 경로를 들고 있지 않으므로 여기서 지워도 잃을 게 없다. 2026-09-23 이전에는
      // 결과가 경로를 가리켜 여기서 지우면 이미지가 통째로 사라졌다.
      const okLog: string[] = [];
      await runCaptureSession(entry(), deps({}, okLog));
      assert.deepEqual(okLog, ["cleanup:/tmp/ig-xyz"]);

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
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 캡처 세션 테스트 통과");
