// 대기열 처리의 실패·재시도 규칙. 브라우저·모델·DB는 전부 주입해 가짜로 돌린다.

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_ATTEMPTS, processPendingCaptures } from "./processPendingCaptures.js";
import { normalizeJudgement } from "./judgeCarouselSlides.js";
import type { InstagramQueueEntry } from "./types.js";
import type { RunCaptureSessionResult } from "./runCaptureSession.js";

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

type ReadySession = Extract<RunCaptureSessionResult, { status: "ready" }>;

const okSession: ReadySession = {
  status: "ready",
  slidesUsed: 2,
  slidesDropped: 0,
  tempDir: "/tmp/ig-capture-test-없는경로",
  capture: {
    queueEntryId: "42",
    instagramUrl: "https://www.instagram.com/p/abc/",
    caption: "캡션",
    burnedInText: [],
    searchKeyword: "주제어",
    category: "entertainment",
    images: [{ slideIndex: 1, kind: "instagram_capture", localPath: "/tmp/a.png" }],
  },
};

type Marks = Array<[string, Record<string, unknown>]>;

function harness(session: RunCaptureSessionResult, entries: InstagramQueueEntry[]) {
  const marks: Marks = [];
  const research: string[] = [];
  return {
    marks,
    research,
    deps: {
      listPending: () => entries,
      runSession: async () => session,
      createJob: async () => ({ jobId: "job-1", imagesSaved: 1, imagesFailed: 0 }),
      triggerResearch: async (jobId: string) => {
        research.push(jobId);
      },
      mark: (id: string, patch: Record<string, unknown>) => {
        marks.push([id, patch]);
      },
    } as Parameters<typeof processPendingCaptures>[0],
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "성공하면 job을 만들고 자료조사를 발화한다",
    async () => {
      const h = harness(okSession, [entry()]);
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.created, 1);
      assert.deepEqual(h.research, ["job-1"], "조사가 발화돼야 한다");
      // 2026-09-23 사용자 결정: 성공은 텔레그램으로 안 알린다. messages가 비어야 폴러가
      // 알림을 아예 안 보낸다(접수 답장 + 초안 도착으로 이미 두 번 알게 된다).
      assert.deepEqual(r.messages, [], "성공은 알리지 않는다 - 세 번째 알림은 소음이다");
    },
  ],
  [
    "실패하면 pending으로 두고 attempts만 올린다",
    async () => {
      const h = harness({ status: "failed", error: "로그인 만료" }, [entry({ attempts: 0 })]);
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.failed, 1);
      assert.equal(r.givenUp, 0);
      assert.deepEqual(h.marks[0][1], { attempts: 1, lastError: "로그인 만료" });
      assert.equal(r.messages.length, 1, "실패는 계속 알려야 한다 - 무인 운영에서 조용하면 모른다");
      assert.ok(r.messages[0].startsWith("⚠️"), r.messages[0]);
      assert.ok(!("status" in h.marks[0][1]), "status를 바꾸면 안 된다 - 다음 폴링에서 재시도해야 한다");
    },
  ],
  [
    `${MAX_ATTEMPTS}회째 실패하면 skipped로 내리고 포기한다`,
    async () => {
      const h = harness({ status: "failed", error: "DOM 변경" }, [entry({ attempts: MAX_ATTEMPTS - 1 })]);
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.givenUp, 1);
      assert.equal(h.marks[0][1].status, "skipped");
      assert.equal(h.marks[0][1].attempts, MAX_ATTEMPTS);
    },
  ],
  [
    "규격에 안 맞는 캡처 결과는 job을 만들지 않는다",
    async () => {
      const broken: ReadySession = {
        ...okSession,
        capture: { ...okSession.capture, searchKeyword: "", category: "연예" as string },
      };
      const h = harness(broken, [entry()]);
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.created, 0);
      assert.equal(r.failed, 1);
      assert.deepEqual(h.research, [], "검증에 걸린 job은 조사도 안 돈다");
    },
  ],
  [
    "job을 만드는 동안 임시 이미지가 살아 있고, 끝나면 지워진다",
    async () => {
      // 2026-09-23 회귀: runCaptureSession이 성공하자마자 tempDir를 지워서 createInstagramJob이
      // 이미지를 못 읽었다. 로그에는 ⚠️ 한 줄만 남고 결과는 "생성 1 / 실패 0"이라 이미지 0장짜리
      // job이 조용히 나갔다. 가짜가 아니라 진짜 파일로 확인한다.
      const dir = await mkdtemp(join(tmpdir(), "ig-capture-test-"));
      const localPath = join(dir, "alt-1.png");
      await writeFile(localPath, "이미지 내용");

      let seenByCreateJob: string | null = null;
      const r = await processPendingCaptures({
        listPending: () => [entry()],
        runSession: async () => ({ ...okSession, tempDir: dir }),
        createJob: async () => {
          // createInstagramJob이 하는 일: localPath를 읽는다. 이때 파일이 있어야 한다.
          seenByCreateJob = await readFile(localPath, "utf-8");
          return { jobId: "job-1", imagesSaved: 1, imagesFailed: 0 };
        },
        triggerResearch: async () => {},
        mark: () => {},
      } as Parameters<typeof processPendingCaptures>[0]);

      assert.equal(r.created, 1);
      assert.deepEqual(r.messages, [], "성공은 알리지 않는다");
      assert.equal(seenByCreateJob, "이미지 내용", "job을 만들 때 이미지가 아직 있어야 한다");
      assert.equal(existsSync(dir), false, "job을 만든 뒤에는 임시 디렉터리를 지워야 한다");
    },
  ],
  [
    "검증에 걸려 job을 안 만들어도 임시 디렉터리는 지운다",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ig-capture-test-"));
      await processPendingCaptures({
        listPending: () => [entry()],
        runSession: async () => ({
          ...okSession,
          tempDir: dir,
          capture: { ...okSession.capture, searchKeyword: "" },
        }),
        createJob: async () => ({ jobId: "job-x", imagesSaved: 0, imagesFailed: 0 }),
        triggerResearch: async () => {},
        mark: () => {},
      } as Parameters<typeof processPendingCaptures>[0]);
      assert.equal(existsSync(dir), false, "어느 갈래로 빠져나가든 정리해야 한다");
      await rm(dir, { recursive: true, force: true });
    },
  ],
  [
    "한 건이 실패해도 나머지를 계속 처리한다",
    async () => {
      let call = 0;
      const marks: Marks = [];
      const research: string[] = [];
      const r = await processPendingCaptures({
        listPending: () => [entry({ id: "1" }), entry({ id: "2" })],
        runSession: async () => {
          call += 1;
          return call === 1 ? { status: "failed", error: "첫 건 실패" } : okSession;
        },
        createJob: async () => ({ jobId: "job-2", imagesSaved: 1, imagesFailed: 0 }),
        triggerResearch: async (jobId: string) => {
          research.push(jobId);
        },
        mark: (id: string, patch: Record<string, unknown>) => marks.push([id, patch]),
        limit: 5,
      } as Parameters<typeof processPendingCaptures>[0]);
      assert.equal(r.attempted, 2);
      assert.equal(r.failed, 1);
      assert.equal(r.created, 1);
      assert.deepEqual(research, ["job-2"]);
    },
  ],
  [
    "조사 발화가 실패해도 job 생성은 성공으로 남는다",
    async () => {
      const h = harness(okSession, [entry()]);
      const r = await processPendingCaptures({
        ...h.deps,
        triggerResearch: async () => {
          throw new Error("큐 장애");
        },
      } as Parameters<typeof processPendingCaptures>[0]);
      assert.equal(r.created, 1, "job은 이미 만들어졌다");
      assert.ok(r.messages.some((m) => m.includes("job:research")), "수동 복구 안내가 있어야 한다");
    },
  ],
  [
    "limit를 넘는 항목은 다음 폴링으로 미룬다",
    async () => {
      const h = harness(okSession, [entry({ id: "1" }), entry({ id: "2" }), entry({ id: "3" })]);
      const r = await processPendingCaptures({ ...h.deps, limit: 2 } as Parameters<typeof processPendingCaptures>[0]);
      assert.equal(r.attempted, 2);
    },
  ],
  [
    "모델 출력 정규화 - 불린이 아니면 안전한 쪽(오버레이 있음)",
    async () => {
      const n = normalizeJudgement({
        searchKeyword: "주제",
        category: "연예",
        slides: [
          { slideIndex: 1, hasOverlay: "yes", burnedInText: null, description: 3 },
          { slideIndex: "2", hasOverlay: false, burnedInText: "", description: "" },
          { slideIndex: 3, hasOverlay: false, burnedInText: "글자", description: "설명" },
        ],
      });
      assert.ok(n);
      assert.equal(n.category, null, "KeywordCategory가 아니면 null");
      assert.equal(n.slides.length, 2, "slideIndex가 정수가 아닌 줄은 버린다");
      assert.equal(n.slides[0].hasOverlay, true, "불린이 아니면 true로 떨어져야 한다");
      assert.equal(n.slides[0].burnedInText, "");
      assert.equal(n.slides[1].hasOverlay, false);
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
  console.error(`\n❌ 대기열 처리 테스트 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 대기열 처리 테스트 통과");
