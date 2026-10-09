// 티스토리 폴러 테스트(processPending·selectDueRequests). 브라우저·DB·텔레그램 없이 돈다. 실행: npm run test:tistory-poll
//
// 지켜야 할 것: ① 예외가 나도 폴러가 죽지 않고 failed로 기록·알림하고 다음 건으로 간다
// ② 발행 성공 후 기록 실패(published_unrecorded)는 재시도 큐로 되돌리지 않고 수동 확인을 알린다
// ③ 로그인 대기(deferred)는 재확인 간격 안이면 이번 주기에 집지 않는다.
import { describeError, processPending, selectDueRequests, shouldRunKeepalive } from "./tistoryPublishPollJob.js";
import type { PollDeps, PollState } from "./tistoryPublishPollJob.js";
import {
  finishTistoryPublish,
  listPendingTistoryRequests,
  readTistoryRequest,
  requestTistoryPublish,
  TISTORY_REQUEST_KEY,
} from "../workflows/publish/tistoryPublishQueue.js";
import type { ArticleJobRow } from "../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const job = (id: string, request?: unknown): ArticleJobRow =>
  ({ id, keyword: `키워드 ${id}`, status: "approved", metadata: request ? { [TISTORY_REQUEST_KEY]: request } : {} }) as ArticleJobRow;

type Recorded = { finished: { id: string; outcome: unknown }[]; deferred: string[]; notices: string[] };

function makeDeps(publish: PollDeps["publish"]): { deps: PollDeps; rec: Recorded } {
  const rec: Recorded = { finished: [], deferred: [], notices: [] };
  const deps: PollDeps = {
    publish,
    finish: (async (id: string, outcome: unknown) => { rec.finished.push({ id, outcome }); }) as PollDeps["finish"],
    defer: (async (j: ArticleJobRow) => { rec.deferred.push(j.id); return {} as never; }) as PollDeps["defer"],
    notify: async (_job, text) => { rec.notices.push(text); },
    saveState: () => {},
  };
  return { deps, rec };
}

const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {};
  return fn().finally(() => { console.log = log; console.error = err; console.warn = warn; });
};

async function main(): Promise<void> {
  // keepalive 판정(2026-10-07): 간격 경과·첫 실행·리포트 직전 보장·끔(0) - 시각은 KST 기준.
  {
    const at = (iso: string): Date => new Date(iso);
    const st = (last?: string) => ({ lastKeepaliveAt: last }) as Parameters<typeof shouldRunKeepalive>[0];
    // 10:00 KST = 01:00Z
    assert(shouldRunKeepalive(st(undefined), at("2026-10-07T01:00:00Z"), 3), "기록이 없으면 돈다");
    assert(!shouldRunKeepalive(st("2026-10-07T00:00:00Z"), at("2026-10-07T01:00:00Z"), 3), "1시간 전이면 안 돈다");
    assert(shouldRunKeepalive(st("2026-10-06T21:00:00Z"), at("2026-10-07T01:00:00Z"), 3), "4시간 지났으면 돈다");
    // 19:30 KST = 10:30Z - 리포트 직전 시간대는 간격과 무관하게 보장(그날 시간대 안에서 이미 돌았으면 중복 안 함)
    assert(shouldRunKeepalive(st("2026-10-07T09:00:00Z"), at("2026-10-07T10:30:00Z"), 99), "리포트 직전엔 간격 무시하고 돈다");
    assert(!shouldRunKeepalive(st("2026-10-07T10:26:00Z"), at("2026-10-07T10:30:00Z"), 99), "시간대 안에서 이미 돌았으면 중복 안 함");
    // 끔(0): 간격 실행은 없고 리포트 직전 보장만 남는다
    assert(!shouldRunKeepalive(st("2026-10-01T00:00:00Z"), at("2026-10-07T01:00:00Z"), 0), "0이면 간격 실행 없음");
    assert(shouldRunKeepalive(st("2026-10-01T00:00:00Z"), at("2026-10-07T10:30:00Z"), 0), "0이어도 리포트 직전은 돈다");
    console.log("✅ shouldRunKeepalive - 간격·첫 실행·리포트 직전 보장·끔");
  }

  // describeError(2026-10-09): Supabase 오류는 Error가 아닌 객체라 "[object Object]"로 찍히던 것을 고쳤다.
  {
    assert(describeError(new Error("붐")) === "붐", "Error는 message");
    assert(describeError({ message: "제한됨", code: "PGRST001" }) === "제한됨 / PGRST001", "객체는 message/code 조합");
    assert(describeError({ foo: 1 }) === '{"foo":1}', "읽을 필드가 없으면 JSON");
    assert(describeError("문자열") === "문자열", "문자열은 그대로");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert(describeError(circular) === "[object Object]", "순환 참조는 String()으로 폴백");
    console.log("✅ describeError - Error·Supabase 객체·순환 참조");
  }

  const state: PollState = {};

  // 1) 예외 -> failed 기록 + 알림, 다음 건은 계속 처리
  {
    const calls: string[] = [];
    const { deps, rec } = makeDeps((async (id: string) => {
      calls.push(id);
      if (id === "a") throw new Error("browser launch failed");
      return { ok: true, publicationId: 1, url: "https://x.tistory.com/entry/b", alreadyDone: false };
    }) as never);
    await quiet(() => processPending([job("a"), job("b")], state, deps));
    process.exitCode = 0; // 예외 경로가 종료 코드를 1로 세팅한다 - 테스트 자체의 종료 코드를 오염시키지 않게.
    assert(calls.join() === "a,b", "예외가 나도 다음 건을 처리해야 한다");
    const a = rec.finished.find((f) => f.id === "a")!.outcome as { ok: boolean; error: string };
    assert(a.ok === false && a.error.includes("browser launch failed"), "예외는 failed로 기록");
    assert(rec.notices.some((n) => n.includes("실패") && n.includes("browser launch failed")), "예외도 알린다");
    assert((rec.finished.find((f) => f.id === "b")!.outcome as { ok: boolean }).ok === true, "b는 정상 완료");
    console.log("✅ 폴러 예외 - failed 기록 + 알림 + 다음 건 계속");
  }

  // 2) 발행 성공 후 기록 실패 -> published_unrecorded, failed·재시도 아님
  {
    const { deps, rec } = makeDeps((async () => ({
      ok: false, reason: "published_unrecorded", url: "https://x.tistory.com/entry/z", detail: "티스토리 발행은 성공했지만 기록에 실패했습니다: db down",
    })) as never);
    await quiet(() => processPending([job("u")], state, deps));
    process.exitCode = 0;
    const out = rec.finished[0].outcome as { ok: unknown; url: string };
    assert(out.ok === "unrecorded" && out.url.endsWith("/z"), "unrecorded로 기록");
    assert(rec.notices.length === 1 && rec.notices[0].includes("직접 확인") && rec.notices[0].includes("/entry/z"), "수동 확인 알림에 URL 포함");
    assert(rec.deferred.length === 0, "보류(재시도)로 돌리지 않는다");
    console.log("✅ published_unrecorded - 재시도 큐로 안 돌리고 수동 확인 알림");
  }

  // 3) 큐: unrecorded 기록 -> 폴러가 안 집고, 다시 요청도 안 받는다
  {
    let stored: Record<string, unknown> = {};
    const mergeMetadata = async (_id: string, patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; return null; };
    await finishTistoryPublish("u", { ok: "unrecorded", url: "https://x/z", error: "db down" }, { mergeMetadata, now: () => new Date("2026-10-06T00:00:00Z") });
    const j = { id: "u", keyword: "k", status: "approved", metadata: stored } as ArticleJobRow;
    const req = readTistoryRequest(j);
    assert(req?.status === "published_unrecorded" && req.url === "https://x/z", "상태·URL 읽힘");
    const pending = await listPendingTistoryRequests({ listRecentJobs: async () => [j] });
    assert(pending.length === 0, "published_unrecorded는 폴러가 집지 않는다");
    let merged = 0;
    const again = await requestTistoryPublish(j, { mergeMetadata: async () => { merged += 1; return null; } });
    assert(!again.queued && merged === 0 && again.reason?.includes("확인"), "다시 눌러도 새 요청이 되지 않는다(중복 발행 방지)");
    console.log("✅ 큐 - published_unrecorded는 집지도 다시 받지도 않는다");
  }

  // 4) deferred 재확인 간격
  {
    const now = new Date("2026-10-06T10:00:00Z");
    const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const old = new Date(now.getTime() - 31 * 60 * 1000).toISOString();
    const due = selectDueRequests(
      [
        job("fresh", { status: "requested", requestedAt: recent }),
        job("d-recent", { status: "deferred", requestedAt: old, deferredAt: old, lastCheckedAt: recent }),
        job("d-old", { status: "deferred", requestedAt: old, deferredAt: old, lastCheckedAt: old }),
        job("d-legacy", { status: "deferred", requestedAt: old, deferredAt: old }), // lastCheckedAt 없는 옛 레코드
      ],
      now
    );
    assert(due.map((j) => j.id).join() === "fresh,d-old,d-legacy", `대기 중 deferred는 간격 전이면 건너뛴다 (${due.map((j) => j.id)})`);
    console.log("✅ deferred 재확인 간격 - 30분 안이면 브라우저를 띄우지 않는다");
  }

  console.log("\n✅ 티스토리 폴러 테스트 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
