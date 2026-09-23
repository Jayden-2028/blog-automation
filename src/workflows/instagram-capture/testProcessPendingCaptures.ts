// 대기열 처리의 실패·재시도·주제 질문 규칙. 브라우저·모델·DB는 전부 주입해 가짜로 돌린다.

import { strict as assert } from "node:assert";

import { MAX_ATTEMPTS, captureFromUserTopic, processPendingCaptures } from "./processPendingCaptures.js";
import type { InstagramQueueEntry } from "./types.js";
import type { RunCaptureSessionResult } from "./runCaptureSession.js";

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

type ReadySession = Extract<RunCaptureSessionResult, { status: "ready" }>;

const okSession: ReadySession = {
  status: "ready",
  slidesRead: 2,
  capture: {
    queueEntryId: "42",
    instagramUrl: "https://www.instagram.com/p/abc/",
    caption: "캡션",
    burnedInText: ["번인"],
    searchKeyword: "주제어",
    category: "entertainment",
  },
};

type Marks = Array<[string, Record<string, unknown>]>;

function harness(session: RunCaptureSessionResult, entries: InstagramQueueEntry[]) {
  const marks: Marks = [];
  const research: string[] = [];
  const asked: string[] = [];
  return {
    marks,
    research,
    asked,
    deps: {
      listPending: () => entries,
      runSession: async () => session,
      createJob: async () => ({ jobId: "job-1" }),
      triggerResearch: async (jobId: string) => {
        research.push(jobId);
      },
      mark: (id: string, patch: Record<string, unknown>) => {
        marks.push([id, patch]);
      },
      askTopic: async (e: InstagramQueueEntry) => {
        asked.push(e.id);
        return 777;
      },
      checkLogin: async () => "logged_in" as const,
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
      assert.ok(!("status" in h.marks[0][1]), "status를 바꾸면 안 된다 - 다음 폴링에서 재시도해야 한다");
      assert.equal(r.messages.length, 1, "실패는 계속 알려야 한다");
    },
  ],
  [
    `${MAX_ATTEMPTS}회째 실패하면 skipped로 내리고, 로그인 상태를 확인해 알린다`,
    async () => {
      // 2026-09-23 사용자 요청: 포기할 때 사용자가 로그인할 수 있도록 알린다. 다만 추측으로
      // 적지 않는다 - 실제로 확인하고 풀렸을 때만 ig:login을 시킨다.
      const h = harness({ status: "failed", error: "게시물을 열지 못했습니다" }, [
        entry({ attempts: MAX_ATTEMPTS - 1 }),
      ]);
      (h.deps as { checkLogin: () => Promise<string> }).checkLogin = async () => "logged_out";
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.givenUp, 1);
      assert.equal(h.marks[0][1].status, "skipped");
      assert.ok(r.messages[0].includes("npm run ig:login"), r.messages[0]);
      assert.ok(r.messages[0].includes("로그인이 풀렸습니다"), r.messages[0]);
    },
  ],
  [
    "로그인이 살아 있으면 ig:login을 시키지 않는다",
    async () => {
      const h = harness({ status: "failed", error: "선택자 불일치" }, [entry({ attempts: MAX_ATTEMPTS - 1 })]);
      const r = await processPendingCaptures(h.deps);
      assert.ok(!r.messages[0].includes("ig:login"), `헛걸음시키면 안 된다: ${r.messages[0]}`);
      assert.ok(r.messages[0].includes("로그인은 살아 있습니다"), r.messages[0]);
    },
  ],
  [
    "읽을 글자가 없으면 실패가 아니라 주제를 물어본다",
    async () => {
      const h = harness({ status: "no_material", instagramUrl: "https://www.instagram.com/p/abc/" }, [entry()]);
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.asked, 1);
      assert.equal(r.failed, 0, "실패가 아니다 - 게시물은 열렸다");
      assert.deepEqual(h.asked, ["42"]);
      assert.equal(h.marks[0][1].status, "needs_topic");
      assert.equal(h.marks[0][1].askedMessageId, 777, "답장을 짚으려면 물어본 메시지 id가 필요하다");
      assert.ok(!("attempts" in h.marks[0][1]), "재시도해도 결과가 같다 - attempts를 올리면 포기로 내려간다");
    },
  ],
  [
    "사용자가 답한 주제로는 게시물을 다시 열지 않는다",
    async () => {
      let reopened = false;
      const r = await processPendingCaptures({
        listPending: () => [entry({ userTopic: "이나영 신작 출연\n관련 정보 정리" })],
        runSession: async () => {
          reopened = true;
          return okSession;
        },
        createJob: async () => ({ jobId: "job-2" }),
        triggerResearch: async () => {},
        mark: () => {},
      } as Parameters<typeof processPendingCaptures>[0]);
      assert.equal(reopened, false, "이미 비어 있는 걸 확인했다 - 다시 열 이유가 없다");
      assert.equal(r.created, 1);
    },
  ],
  [
    "사용자 주제는 캡션 자리에 그대로 들어간다",
    () => {
      const capture = captureFromUserTopic(entry({ userTopic: "이나영 신작 출연\n둘째 줄" }));
      assert.equal(capture.caption, "이나영 신작 출연\n둘째 줄", "조사의 1차 근거가 된다");
      assert.equal(capture.searchKeyword, "이나영 신작 출연", "주제어는 첫 줄");
      assert.deepEqual(capture.burnedInText, []);
      return Promise.resolve();
    },
  ],
  [
    "규격에 안 맞는 결과는 job을 만들지 않는다",
    async () => {
      const broken: ReadySession = { ...okSession, capture: { ...okSession.capture, searchKeyword: "" } };
      const h = harness(broken, [entry()]);
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.created, 0);
      assert.equal(r.failed, 1);
      assert.deepEqual(h.research, [], "검증에 걸린 job은 조사도 안 돈다");
    },
  ],
  [
    "한 건이 실패해도 나머지를 계속 처리한다",
    async () => {
      let call = 0;
      const research: string[] = [];
      const r = await processPendingCaptures({
        listPending: () => [entry({ id: "1" }), entry({ id: "2" })],
        runSession: async () => {
          call += 1;
          return call === 1 ? { status: "failed", error: "첫 건 실패" } : okSession;
        },
        createJob: async () => ({ jobId: "job-2" }),
        triggerResearch: async (jobId: string) => {
          research.push(jobId);
        },
        mark: () => {},
        checkLogin: async () => "logged_in" as const,
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
      (h.deps as { triggerResearch: () => Promise<void> }).triggerResearch = async () => {
        throw new Error("워크플로 디스패치 실패");
      };
      const r = await processPendingCaptures(h.deps);
      assert.equal(r.created, 1, "job은 이미 만들어졌다");
      assert.ok(r.messages.some((m) => m.includes("job:research")), "이어 돌리는 방법을 알려야 한다");
    },
  ],
  [
    "limit를 넘는 항목은 다음 폴링으로 미룬다",
    async () => {
      const h = harness(okSession, [entry({ id: "1" }), entry({ id: "2" }), entry({ id: "3" })]);
      const r = await processPendingCaptures({ ...h.deps, limit: 2 });
      assert.equal(r.attempted, 2);
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
console.log("\n🎉 대기열 처리 테스트 통과");
