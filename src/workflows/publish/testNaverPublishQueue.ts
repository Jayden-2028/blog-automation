// 네이버 발행 대기열 테스트. 실행: npm run test:naver-queue
//
// 지켜야 할 것: ① 버튼을 두 번 눌러도 요청이 밀리지 않는다 ② 이미 올라간 건 다시 안 넣는다
// ③ 실패한 건은 다시 넣을 수 있다 ④ 오래된 요청부터 처리한다.
import {
  finishNaverPublish,
  listPendingNaverRequests,
  NAVER_REQUEST_KEY,
  readNaverRequest,
  requestNaverPublish,
} from "./naverPublishQueue.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const job = (id: string, request?: unknown): ArticleJobRow =>
  ({ id, keyword: `키워드 ${id}`, status: "approved", metadata: request ? { [NAVER_REQUEST_KEY]: request } : {} }) as ArticleJobRow;

async function main(): Promise<void> {
  console.log("▶ 네이버 발행 대기열 테스트 시작\n");

  // 1) 처음 누르면 예약된다.
  {
    const patches: Record<string, unknown>[] = [];
    const out = await requestNaverPublish(job("a"), {
      mergeMetadata: async (_id, patch) => { patches.push(patch); return null; },
      now: () => new Date("2026-09-22T01:00:00Z"),
    });
    assert(out.queued, "처음 누르면 예약돼야 한다");
    const saved = patches[0][NAVER_REQUEST_KEY] as { status: string; requestedAt: string };
    assert(saved.status === "requested", "상태가 requested여야 한다");
    assert(saved.requestedAt === "2026-09-22T01:00:00.000Z", "요청 시각이 남아야 한다");
    console.log("✅ 첫 요청 - 예약 + 시각 기록");
  }

  // 2) 이미 대기 중이면 덮어쓰지 않는다. 버튼을 두 번 눌러도 순서가 밀리면 안 된다.
  {
    let merged = 0;
    const out = await requestNaverPublish(job("a", { status: "requested", requestedAt: "2026-09-22T01:00:00.000Z" }), {
      mergeMetadata: async () => { merged += 1; return null; },
    });
    assert(!out.queued && merged === 0, "이미 대기 중이면 DB를 건드리면 안 된다");
    assert(out.reason?.includes("대기"), `사유가 분명해야 한다 (${out.reason})`);
    console.log("✅ 중복 클릭 - 요청 시각이 밀리지 않는다");
  }

  // 3) 이미 올라간 건 다시 넣지 않는다(같은 글이 두 번 올라가면 유사문서 사고).
  {
    let merged = 0;
    const out = await requestNaverPublish(job("a", { status: "done", requestedAt: "x", url: "https://b/1" }), {
      mergeMetadata: async () => { merged += 1; return null; },
    });
    assert(!out.queued && merged === 0, "이미 올라갔으면 다시 넣으면 안 된다");
    console.log("✅ 발행 완료된 건 재예약 차단");
  }

  // 4) 실패한 건은 다시 넣을 수 있다 - 사람이 고치고 다시 누르는 경로다.
  {
    const out = await requestNaverPublish(job("a", { status: "failed", requestedAt: "x", error: "무언가 실패" }), {
      mergeMetadata: async () => null,
    });
    assert(out.queued, "실패한 건은 다시 예약할 수 있어야 한다");
    console.log("✅ 실패 건 재예약 허용");
  }

  // 5) 결과를 적으면 대기열에서 빠진다.
  {
    const patches: Record<string, unknown>[] = [];
    await finishNaverPublish("a", { ok: true, url: "https://blog.naver.com/x/1" }, {
      mergeMetadata: async (_id, patch) => { patches.push(patch); return null; },
      now: () => new Date("2026-09-22T02:00:00Z"),
    });
    const saved = patches[0][NAVER_REQUEST_KEY] as { status: string; url: string; finishedAt: string };
    assert(saved.status === "done" && saved.url.includes("blog.naver.com"), "완료 상태와 주소가 남아야 한다");
    assert(saved.finishedAt === "2026-09-22T02:00:00.000Z", "완료 시각이 남아야 한다");

    const fail: Record<string, unknown>[] = [];
    await finishNaverPublish("b", { ok: false, error: "본문 입력 실패" }, {
      mergeMetadata: async (_id, patch) => { fail.push(patch); return null; },
    });
    assert((fail[0][NAVER_REQUEST_KEY] as { status: string; error: string }).error === "본문 입력 실패", "실패 사유가 남아야 한다");
    console.log("✅ 처리 결과 기록 - 성공/실패 모두");
  }

  // 6) 대기 중인 것만, 오래된 것부터 돌려준다.
  {
    const jobs = [
      job("new", { status: "requested", requestedAt: "2026-09-22T05:00:00Z" }),
      job("done", { status: "done", requestedAt: "2026-09-22T01:00:00Z" }),
      job("old", { status: "requested", requestedAt: "2026-09-22T03:00:00Z" }),
      job("none"),
    ];
    const pending = await listPendingNaverRequests({ listRecentJobs: async () => jobs });
    assert(pending.length === 2, `대기 중인 것만 나와야 한다 (${pending.map((j) => j.id)})`);
    assert(pending[0].id === "old" && pending[1].id === "new", `오래된 것부터여야 한다 (${pending.map((j) => j.id)})`);
    console.log("✅ 대기열 - 대기 중인 것만, 오래된 순");
  }

  // 7) 형식이 깨진 값은 없는 것으로 본다(옛 데이터·수동 편집 방어).
  {
    assert(readNaverRequest(job("a")) === null, "metadata가 비면 null");
    assert(readNaverRequest(job("a", "문자열")) === null, "객체가 아니면 null");
    assert(readNaverRequest(job("a", { status: "이상한값" })) === null, "모르는 상태는 null");
    console.log("✅ 깨진 값은 없는 것으로 처리");
  }

  console.log("\n🎉 네이버 발행 대기열 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
