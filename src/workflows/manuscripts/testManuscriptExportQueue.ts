// 보관함 내보내기 대기열 테스트. 실행: npm run test:export-queue
//
// 지켜야 할 것: ① 버튼을 두 번 눌러도 요청 시각이 밀리지 않는다 ② 이미 받은 건도 **다시**
// 요청할 수 있다(네이버 발행과 다른 점 - 다시 받는 것은 덮어쓰기일 뿐이다) ③ 결과를 쓸 때
// 원래 요청 시각을 지운다면 "얼마나 묵었나"를 영영 알 수 없다 ④ 오래된 요청부터 처리한다.
import {
  EXPORT_REQUEST_KEY,
  finishManuscriptExport,
  listPendingExportRequests,
  readExportRequest,
  requestManuscriptExport,
} from "./manuscriptExportQueue.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const job = (id: string, request?: unknown): ArticleJobRow =>
  ({ id, keyword: `키워드 ${id}`, status: "approved", metadata: request ? { [EXPORT_REQUEST_KEY]: request } : {} }) as ArticleJobRow;

async function main(): Promise<void> {
  console.log("▶ 보관함 내보내기 대기열 테스트 시작\n");

  // 1) 처음 누르면 요청된다.
  {
    const patches: Record<string, unknown>[] = [];
    const out = await requestManuscriptExport(job("a"), {
      mergeMetadata: async (_id, patch) => { patches.push(patch); return null; },
      now: () => new Date("2026-09-29T01:00:00Z"),
    });
    assert(out.queued, "처음 누르면 요청돼야 한다");
    const saved = patches[0][EXPORT_REQUEST_KEY] as { status: string; requestedAt: string };
    assert(saved.status === "requested", "상태가 requested여야 한다");
    assert(saved.requestedAt === "2026-09-29T01:00:00.000Z", "요청 시각이 남아야 한다");
    console.log("✅ 첫 요청 - 기록됨");
  }

  // 2) 이미 대기 중이면 덮어쓰지 않는다. 연타해도 순서가 밀리면 안 된다.
  {
    let merged = 0;
    const out = await requestManuscriptExport(job("a", { status: "requested", requestedAt: "2026-09-29T01:00:00.000Z" }), {
      mergeMetadata: async () => { merged += 1; return null; },
    });
    assert(!out.queued && merged === 0, "이미 대기 중이면 DB를 건드리면 안 된다");
    console.log("✅ 중복 클릭 - 요청 시각이 밀리지 않는다");
  }

  // 3) 이미 받은 건도 다시 요청할 수 있다. 이미지 수정 뒤 다시 받는 것이 정상 흐름이라,
  //    네이버 발행처럼 막으면 안 된다.
  {
    let merged = 0;
    const out = await requestManuscriptExport(job("a", { status: "done", requestedAt: "x", dir: "/tmp/a" }), {
      mergeMetadata: async () => { merged += 1; return null; },
      now: () => new Date("2026-09-29T02:00:00Z"),
    });
    assert(out.queued && merged === 1, "완료된 건도 다시 요청할 수 있어야 한다");
    console.log("✅ 다시 내려받기 허용");
  }

  // 4) 실패한 건도 다시 요청할 수 있다.
  {
    const out = await requestManuscriptExport(job("a", { status: "failed", requestedAt: "x", error: "boom" }), {
      mergeMetadata: async () => null,
    });
    assert(out.queued, "실패한 건은 다시 요청할 수 있어야 한다");
    console.log("✅ 실패 후 재요청 허용");
  }

  // 5) 결과를 써도 원래 요청 시각은 남는다.
  {
    const patches: Record<string, unknown>[] = [];
    await finishManuscriptExport(
      job("a", { status: "requested", requestedAt: "2026-09-29T01:00:00.000Z" }),
      { ok: true, dir: "/Users/x/blog-manuscripts/whyissuenow/2026-09-29/여름방학" },
      {
        mergeMetadata: async (_id, patch) => { patches.push(patch); return null; },
        now: () => new Date("2026-09-29T01:00:30Z"),
      }
    );
    const saved = patches[0][EXPORT_REQUEST_KEY] as { status: string; requestedAt: string; finishedAt: string; dir: string };
    assert(saved.status === "done", "완료 상태여야 한다");
    assert(saved.requestedAt === "2026-09-29T01:00:00.000Z", "원래 요청 시각이 지워지면 안 된다");
    assert(saved.finishedAt === "2026-09-29T01:00:30.000Z", "완료 시각이 남아야 한다");
    assert(saved.dir.endsWith("여름방학"), "폴더 경로가 남아야 한다(사용자에게 알려줄 값)");
    console.log("✅ 완료 기록 - 요청 시각 보존 + 폴더 경로");
  }

  // 6) 실패도 사유와 함께 남는다.
  {
    const patches: Record<string, unknown>[] = [];
    await finishManuscriptExport(job("a"), { ok: false, error: "원고 목록에 없음" }, {
      mergeMetadata: async (_id, patch) => { patches.push(patch); return null; },
    });
    const saved = patches[0][EXPORT_REQUEST_KEY] as { status: string; error: string };
    assert(saved.status === "failed" && saved.error === "원고 목록에 없음", "실패 사유가 남아야 한다");
    console.log("✅ 실패 기록");
  }

  // 7) 대기 중인 것만, 오래된 순서로 돌려준다.
  {
    const jobs = [
      job("new", { status: "requested", requestedAt: "2026-09-29T03:00:00.000Z" }),
      job("done", { status: "done", requestedAt: "2026-09-29T01:00:00.000Z" }),
      job("old", { status: "requested", requestedAt: "2026-09-29T02:00:00.000Z" }),
      job("none"),
    ];
    const pending = await listPendingExportRequests({ listRecentJobs: async () => jobs });
    assert(pending.length === 2, `대기 중인 2건만 나와야 한다 (실제: ${pending.length})`);
    assert(pending[0].id === "old" && pending[1].id === "new", "오래된 요청이 먼저여야 한다");
    console.log("✅ 대기열 - 상태 필터 + 오래된 순서");
  }

  // 8) metadata가 깨져 있어도 터지지 않는다(옛 job·수기 수정).
  {
    assert(readExportRequest(job("a", "문자열")) === null, "문자열 metadata는 null이어야 한다");
    assert(readExportRequest(job("a", { status: "무엇" })) === null, "모르는 상태는 null이어야 한다");
    assert(readExportRequest(job("a")) === null, "요청이 없으면 null이어야 한다");
    console.log("✅ 깨진 metadata - 조용히 null");
  }

  console.log("\n✅ 보관함 내보내기 대기열 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
