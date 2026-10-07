// 티스토리 발행 대기열 테스트. 실행: npm run test:tistory-queue
//
// 지켜야 할 것: ① 두 번 눌러도 요청이 밀리지 않는다 ② 로그인 풀림은 failed가 아니라 deferred고 재로그인 후 폴러가
// 다시 집는다 ③ deferred가 3일 넘으면 자동 재개하지 않고, 다시 누르면 새 요청으로 받는다 ④ 완료 건은 다시 안 넣는다.
import {
  deferTistoryPublish,
  finishTistoryPublish,
  isDeferredExpired,
  listExpiredDeferred,
  listPendingTistoryRequests,
  readTistoryRequest,
  requestTistoryPublish,
  TISTORY_REQUEST_KEY,
} from "./tistoryPublishQueue.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const job = (id: string, request?: unknown): ArticleJobRow =>
  ({ id, keyword: `키워드 ${id}`, status: "approved", metadata: request ? { [TISTORY_REQUEST_KEY]: request } : {} }) as ArticleJobRow;

const T0 = new Date("2026-10-06T01:00:00Z");

async function main(): Promise<void> {
  console.log("▶ 티스토리 발행 대기열 테스트 시작\n");

  // 1) 처음 누르면 예약 + 출처 기록
  {
    const patches: Record<string, unknown>[] = [];
    const out = await requestTistoryPublish(job("a"), { mergeMetadata: async (_id, patch) => { patches.push(patch); return null; }, now: () => T0, source: "viewer" });
    assert(out.queued, "처음 누르면 예약돼야 한다");
    const saved = patches[0][TISTORY_REQUEST_KEY] as { status: string; requestedAt: string; source?: string };
    assert(saved.status === "requested" && saved.requestedAt === T0.toISOString() && saved.source === "viewer", "requested + 시각 + 출처");
    console.log("✅ 첫 요청 - 예약 + 시각 + 출처");
  }

  // 2) 대기 중이면 덮어쓰지 않는다 / 완료 건은 다시 안 넣는다 / 실패 건은 다시 넣는다
  {
    // 호출 횟수는 함수로 읽는다 - assert의 타입 좁힘이 closure 안의 += 를 못 봐서 리터럴 비교를 오류로 잡는다.
    const calls: number[] = [];
    const merged = (): number => calls.length;
    const mergeMetadata = async () => { calls.push(1); return null; };
    const waiting = await requestTistoryPublish(job("b", { status: "requested", requestedAt: "x" }), { mergeMetadata });
    assert(!waiting.queued && merged() === 0, "대기 중이면 덮어쓰지 않는다");
    const done = await requestTistoryPublish(job("c", { status: "done", requestedAt: "" }), { mergeMetadata });
    assert(!done.queued && merged() === 0, "완료 건은 다시 넣지 않는다");
    const failed = await requestTistoryPublish(job("d", { status: "failed", requestedAt: "", error: "x" }), { mergeMetadata });
    assert(failed.queued && merged() === 1, "실패 건은 다시 넣을 수 있다");
    console.log("✅ 중복 클릭·완료·실패 처리");
  }

  // 3) 로그인 풀림 -> deferred. 요청 시각·deferredAt은 재시도에도 보존, 알림 시각은 notified일 때만
  {
    const patches: Record<string, unknown>[] = [];
    const mergeMetadata = async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); return null; };
    const first = await deferTistoryPublish(job("e", { status: "requested", requestedAt: T0.toISOString(), source: "telegram" }), { mergeMetadata, now: () => new Date("2026-10-06T02:00:00Z"), notified: true });
    assert(first.status === "deferred" && first.requestedAt === T0.toISOString() && first.deferredAt === "2026-10-06T02:00:00.000Z" && first.notifiedAt === "2026-10-06T02:00:00.000Z" && first.source === "telegram", `첫 보류 (${JSON.stringify(first)})`);
    const again = await deferTistoryPublish(job("e", first), { mergeMetadata, now: () => new Date("2026-10-06T03:00:00Z") });
    assert(again.deferredAt === first.deferredAt && again.notifiedAt === first.notifiedAt && again.requestedAt === T0.toISOString(), "재시도해도 시각이 밀리지 않는다");
    // 보류 중에 또 누르면 안내만
    const pressed = await requestTistoryPublish(job("e", again), { mergeMetadata, now: () => new Date("2026-10-07T00:00:00Z") });
    assert(!pressed.queued && /로그인/.test(pressed.reason ?? ""), "보류 중 재클릭은 로그인 안내");
    console.log("✅ 로그인 풀림 -> deferred, 시각 보존, 재클릭 안내");
  }

  // 4) 폴러 대기열: requested + 만료 안 된 deferred, 오래된 것부터. 만료된 deferred는 제외
  {
    const now = new Date("2026-10-10T00:00:00Z");
    const jobs = [
      job("new", { status: "requested", requestedAt: "2026-10-09T00:00:00Z" }),
      job("old", { status: "requested", requestedAt: "2026-10-08T00:00:00Z" }),
      job("def", { status: "deferred", requestedAt: "2026-10-08T12:00:00Z", deferredAt: "2026-10-09T00:00:00Z" }),
      job("expired", { status: "deferred", requestedAt: "2026-10-01T00:00:00Z", deferredAt: "2026-10-02T00:00:00Z" }),
      job("done", { status: "done", requestedAt: "" }),
      job("none"),
    ];
    const pending = await listPendingTistoryRequests({ listRecentJobs: async () => jobs, now: () => now, deferredMaxDays: 3 });
    assert(JSON.stringify(pending.map((j) => j.id)) === JSON.stringify(["old", "def", "new"]), `대기열 순서 (${pending.map((j) => j.id).join(",")})`);
    const expired = listExpiredDeferred(jobs, now, 3);
    assert(expired.length === 1 && expired[0].id === "expired", "만료된 보류 건만 골라낸다");
    assert(isDeferredExpired(readTistoryRequest(jobs[3])!, now, 3) && !isDeferredExpired(readTistoryRequest(jobs[2])!, now, 3), "만료 판정");
    // 만료된 건을 다시 누르면 새 요청으로 받는다
    const reCalls: number[] = [];
    const re = await requestTistoryPublish(jobs[3], { mergeMetadata: async () => { reCalls.push(1); return null; }, now: () => now, deferredMaxDays: 3 });
    assert(re.queued && reCalls.length === 1, "만료된 보류 건은 다시 누르면 새 요청");
    console.log("✅ 대기열 - 순서, 3일 만료 제외, 만료 건 재요청");
  }

  // 5) 결과 기록
  {
    const patches: Record<string, unknown>[] = [];
    const mergeMetadata = async (_id: string, patch: Record<string, unknown>) => { patches.push(patch); return null; };
    await finishTistoryPublish("f", { ok: true, url: "https://wooahpapa.tistory.com/entry/x" }, { mergeMetadata, now: () => T0 });
    await finishTistoryPublish("g", { ok: false, error: "boom" }, { mergeMetadata, now: () => T0 });
    const ok = patches[0][TISTORY_REQUEST_KEY] as { status: string; url?: string };
    const ng = patches[1][TISTORY_REQUEST_KEY] as { status: string; error?: string };
    assert(ok.status === "done" && ok.url?.includes("/entry/x") && ng.status === "failed" && ng.error === "boom", "done/failed 기록");
    console.log("✅ 결과 기록");
  }

  // 뷰어 수정 반영·이미지 교체가 진행 중인 건은 이번 주기에 집지 않는다(2026-10-07, VIEWER-REFINE §2-c). requested·deferred 모두.
  {
    const now = new Date("2026-10-07T01:00:00Z");
    const withMeta = (id: string, request: unknown, extra: Record<string, unknown>) =>
      ({ id, keyword: `키워드 ${id}`, status: "approved", metadata: { [TISTORY_REQUEST_KEY]: request, ...extra } }) as unknown as ArticleJobRow;
    const req = { status: "requested", requestedAt: "2026-10-07T00:59:00Z" };
    const jobs = [
      withMeta("edit-running", req, { viewerEditPendingAt: "2026-10-07T00:59:30Z" }),
      withMeta("pick-running-deferred", { status: "deferred", requestedAt: "2026-10-07T00:00:00Z", deferredAt: "2026-10-07T00:10:00Z" }, { imagePickPendingAt: "2026-10-07T00:59:30Z" }),
      withMeta("edit-done", req, { viewerEditPendingAt: "2026-10-07T00:58:00Z", viewerEdit: { appliedAt: "2026-10-07T00:58:40Z" } }),
      withMeta("edit-stale", req, { viewerEditPendingAt: "2026-10-07T00:30:00Z" }),
      withMeta("clean", req, {}),
    ];
    const stale: string[] = [];
    const pending = await listPendingTistoryRequests({ listRecentJobs: async () => jobs, now: () => now, deferredMaxDays: 3, onStale: (j) => stale.push(j.id) });
    assert(pending.map((j) => j.id).sort().join() === "clean,edit-done,edit-stale", `진행 중인 건은 건너뛴다 (${pending.map((j) => j.id)})`);
    assert(stale.join() === "edit-stale", `10분 넘게 묵은 건은 통과시키되 알린다 (${stale})`);
    console.log("✅ 수정 반영·이미지 교체 진행 중인 건은 건너뛰고, stale은 통과+알림");
  }

  console.log("\n✅ 티스토리 발행 대기열 테스트 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
