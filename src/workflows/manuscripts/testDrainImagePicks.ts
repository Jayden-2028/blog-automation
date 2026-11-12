// 후보 이미지 클릭 교체 **드레인**(큐 비우기) 테스트. 실행: npm run test:viewer-image-pick-queue
// DB·네트워크를 쓰지 않는다 - 가짜 큐 + 가짜 저장소를 주입한다(testApplyImagePick와 같은 방식).
//
// 지켜야 할 것:
//  ① 3건이 한 run에서 **요청 순서대로** 처리된다(가운데 것이 사라지지 않는다 - 2026-11-12 사고).
//  ② 같은 슬롯 중복은 **나중 것만** 적용되고 앞의 것은 skipped로 마감된다.
//  ③ 한 건이 실패해도 나머지는 계속 간다.
//  ④ 드레인 중 들어온 요청을 **같은 run이** 집는다(한 바퀴 돈 뒤 다시 읽는다).
//  ⑤ 배포는 **마지막에 한 번**, 알림은 **한 통**(옛 동작은 건당 1회·1통이었다).
//  ⑥ 큐가 비어 있으면 아무것도 하지 않고 **진행 중 표식만 풀어 준다**(앞 run이 이미 비웠다).
//  ⑦ 테이블이 없으면(migration 미적용) 옛 경로(payload 단건)로 떨어진다 - 적용 전 병합이 안전해야 한다.
//  ⑧ 같은 슬롯 접기는 순수 함수(foldSameSlot)로 검증 가능하다.
import {
  DEFAULT_MAX_ITEMS,
  drainImagePicks,
  foldSameSlot,
  imagePickDrainMessage,
} from "./drainImagePicks.js";
import type { DrainPickResult } from "./drainImagePicks.js";
import { ImagePickQueueUnavailableError, isQueueTableMissing } from "./imagePickQueue.js";
import type { ImagePickQueue, ImagePickQueueItem } from "./imagePickQueue.js";
import type { ApplyImagePickDeps } from "./applyImagePick.js";
import { IMAGE_PICK_PENDING_KEY } from "./viewerEditGuard.js";
import type { ImageCandidateRecord, ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "054bfe0b-1234-4abc-8def-0123456789ab";

/** 슬롯 1·3·7에 각각 후보 4개. */
const CANDS: Record<string, ImageCandidateRecord[]> = Object.fromEntries(
  [1, 3, 7].map((slot) => [
    String(slot),
    [1, 2, 3, 4].map((n) => ({ number: n, url: `https://c.example/${slot}-${n}.jpg`, sourcePage: `https://c.example/p${slot}-${n}`, picked: n === 1 })),
  ])
);

function image(index: number): ManuscriptImage {
  return {
    index,
    description: `캡션${index}`,
    prompt: null,
    url: `https://x.supabase.co/old-${index}.jpg`,
    provider: "web",
    fileName: `0${index}-a.jpg`,
    sourcePage: `https://c.example/p${index}-1`,
    license: "공식",
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);

/**
 * 가짜 DB. loadJob이 **쓰기 결과를 반영**해야 한다 - 드레인이 한 건을 끝낸 뒤 다음 건을 읽을 때
 * 앞 교체가 보여야 하고, 그러지 않으면 이 테스트가 옛 버그(옛 상태로 덮어쓰기)를 통과시킨다.
 */
function makeWorld() {
  const metadata: Record<string, unknown> = { images: [image(1), image(3), image(7)], imageCandidates: CANDS };
  let topic: ManuscriptTopicEntry = {
    jobId: JOB_ID,
    keyword: "테스트 키워드",
    category: null,
    date: "2026-11-12",
    readyAt: "2026-11-12T00:00:00Z",
    manuscript: {
      title: "t", searchDescription: null, slug: null, tags: [], body: "", imagePrompts: [], filePath: "",
      images: metadata.images as ManuscriptImage[],
      imageCandidates: CANDS,
    },
  };
  const calls = { deploys: 0, notified: [] as string[], uploads: 0, metadataPatches: [] as Record<string, unknown>[] };
  let uploadCounter = 0;

  const deps: ApplyImagePickDeps = {
    loadJob: async () => ({ id: JOB_ID, keyword: "테스트 키워드", metadata: { ...metadata } }) as unknown as ArticleJobRow,
    loadManifest: async () => ({ topics: [topic] }) as ManuscriptManifest,
    fetchImage: async () => ({ ok: true, buffer: JPEG, contentType: "image/jpeg" }),
    readSize: () => ({ width: 1600, height: 900 }),
    cropTall: async () => ({ ok: false, error: "no chromium" }),
    upload: async () => {
      calls.uploads += 1;
      uploadCounter += 1;
      return { ok: true, url: `https://x.supabase.co/new-${uploadCounter}.webp`, extension: "webp" };
    },
    mergeJobMetadata: async (_id, patch) => {
      calls.metadataPatches.push(patch);
      Object.assign(metadata, patch);
    },
    saveTopic: async (t) => {
      topic = t;
    },
    publishPage: async () => {
      calls.deploys += 1;
    },
    isPublished: async () => false,
    notify: async (_job, text) => {
      calls.notified.push(text);
    },
    now: (() => {
      let n = 0;
      return () => new Date(Date.UTC(2026, 10, 12, 0, 0, n++));
    })(),
  };
  return { deps, calls, metadata, readTopic: () => topic };
}

/** 가짜 큐. onRound로 "드레인 중 새 요청이 들어오는" 상황을 만든다. */
function makeQueue(initial: ImagePickQueueItem[], onRound?: (round: number, push: (item: ImagePickQueueItem) => void) => void) {
  const rows = new Map<string, { item: ImagePickQueueItem; status: string; error?: string }>();
  for (const item of initial) rows.set(item.id, { item, status: "pending" });
  let round = 0;
  const reads: string[][] = [];

  const queue: ImagePickQueue = {
    listPending: async (jobId) => {
      onRound?.(round, (item) => rows.set(item.id, { item, status: "pending" }));
      round += 1;
      const pending = [...rows.values()]
        .filter((r) => r.status === "pending" && r.item.jobId === jobId)
        .map((r) => r.item)
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
      reads.push(pending.map((p) => p.id));
      return pending;
    },
    markProcessed: async (id, status, error) => {
      const row = rows.get(id);
      assert(row, `큐에 없는 행을 마감하려 한다: ${id}`);
      row.status = status;
      row.error = error;
    },
  };
  return { queue, rows, reads, rounds: () => round };
}

function item(n: number, slot: number, candidate: number, fromUrl: string): ImagePickQueueItem {
  return {
    id: `req-${n}`,
    jobId: JOB_ID,
    slotIndex: slot,
    candidateNumber: candidate,
    fromUrl,
    requestedAt: `2026-11-12T00:00:${String(n).padStart(2, "0")}.000Z`,
  };
}

const old = (slot: number) => `https://x.supabase.co/old-${slot}.jpg`;

async function main(): Promise<void> {
  // ⑧ 같은 슬롯 접기(순수 함수)
  {
    const items = [item(1, 1, 2, old(1)), item(2, 3, 4, old(3)), item(3, 1, 3, old(1))];
    const { apply, folded } = foldSameSlot(items);
    assert(apply.map((i) => i.id).join() === "req-2,req-3", `살아남는 건 슬롯별 마지막 요청이다 (${apply.map((i) => i.id)})`);
    assert(folded.map((i) => i.id).join() === "req-1", "앞 요청만 접힌다");
    const none = foldSameSlot([item(1, 1, 2, "")]);
    assert(none.folded.length === 0 && none.apply.length === 1, "중복이 없으면 아무것도 접지 않는다");
    console.log("✅ 같은 슬롯 접기 - 나중 것이 이긴다");
  }

  // ① 3건이 한 run에서 순서대로 ② 배포 1회·알림 1통 (⑤)
  {
    const { deps, calls, metadata } = makeWorld();
    const { queue, rows } = makeQueue([item(1, 1, 2, old(1)), item(2, 3, 3, old(3)), item(3, 7, 4, old(7))]);
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: old(1) }, deps, queue });

    assert(out.mode === "queue", `큐 모드여야 한다 (${out.mode})`);
    assert(out.results.length === 3, `3건 모두 처리 (${JSON.stringify(out.results)})`);
    assert(out.results.every((r) => r.status === "applied"), "3건 모두 적용");
    assert(out.results.map((r) => r.slotIndex).join() === "1,3,7", `요청 순서대로 (${out.results.map((r) => r.slotIndex)})`);
    assert([...rows.values()].every((r) => r.status === "done"), "큐 행 3개 모두 done으로 마감");

    // 가운데 것이 사라지지 않는다 = 세 슬롯 전부 새 URL이다. 2026-11-12 사고의 핵심 단정.
    const images = metadata.images as ManuscriptImage[];
    for (const slot of [1, 3, 7]) {
      const url = images.find((i) => i.index === slot)!.url ?? "";
      assert(url.startsWith("https://x.supabase.co/new-"), `${slot}번이 새 이미지여야 한다 (${url})`);
    }
    assert(images.find((i) => i.index === 1)!.description === "캡션1", "캡션은 그대로");
    assert(calls.uploads === 3, `업로드 3회 (${calls.uploads})`);
    assert(calls.deploys === 1, `배포는 마지막에 한 번 (${calls.deploys}회)`);
    assert(out.deploys === 1, "결과에도 배포 1회로 남는다");
    assert(calls.notified.length === 1, `알림은 한 통 (${calls.notified.length}통)`);
    const text = calls.notified[0];
    for (const line of ["1번 ← 후보 2번 ✅", "3번 ← 후보 3번 ✅", "7번 ← 후보 4번 ✅"]) {
      assert(text.includes(line), `알림에 "${line}"이 있어야 한다\n${text}`);
    }
    assert(text.includes("캡션은 그대로"), "캡션 안내를 담는다");
    console.log("✅ 3건을 한 run에서 순서대로 · 배포 1회 · 알림 1통");
  }

  // ② 같은 슬롯 중복: 나중 것만 적용, 앞은 skipped
  {
    const { deps, calls, metadata } = makeWorld();
    // 1번 자리를 후보 2 -> 후보 4로 연달아 누른 상황. 뒤 요청의 fromUrl도 뷰어가 본 옛 URL이다.
    const { queue, rows } = makeQueue([item(1, 1, 2, old(1)), item(2, 1, 4, old(1)), item(3, 3, 2, old(3))]);
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: old(1) }, deps, queue });

    assert(rows.get("req-1")!.status === "skipped", `앞 요청은 skipped (${rows.get("req-1")!.status})`);
    assert(rows.get("req-2")!.status === "done" && rows.get("req-3")!.status === "done", "살아남은 요청만 적용");
    const applied = out.results.filter((r) => r.status === "applied");
    assert(applied.length === 2 && applied.some((r) => r.slotIndex === 1 && r.candidateNumber === 4), "1번은 후보 4번으로 적용");
    assert(calls.uploads === 2, `접힌 건은 내려받지도 올리지도 않는다 (${calls.uploads})`);
    const picked = (metadata.imageCandidates as Record<string, ImageCandidateRecord[]>)["1"].find((c) => c.picked);
    assert(picked?.number === 4, `picked도 나중 것으로 (${picked?.number})`);
    assert(calls.notified[0].includes("⏭"), "건너뜀도 알림에 적는다");
    console.log("✅ 같은 슬롯 중복 - 나중 것만 적용, 앞은 skipped");
  }

  // ③ 한 건이 실패해도 나머지는 계속
  {
    const { deps, calls } = makeWorld();
    const original = deps.fetchImage;
    deps.fetchImage = async (input) => (input.url.includes("3-3") ? { ok: false, error: "HTTP 403" } : original(input));
    const { queue, rows } = makeQueue([item(1, 1, 2, old(1)), item(2, 3, 3, old(3)), item(3, 7, 4, old(7))]);
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: old(1) }, deps, queue });

    assert(out.results.filter((r) => r.status === "applied").length === 2, "실패 한 건을 빼고 둘은 적용");
    const failed = out.results.find((r) => r.status === "failed");
    assert(failed?.slotIndex === 3 && failed.error?.includes("403"), `실패 사유가 남는다 (${JSON.stringify(failed)})`);
    assert(rows.get("req-2")!.status === "failed" && rows.get("req-2")!.error?.includes("403"), "큐 행도 failed + 사유");
    assert(rows.get("req-3")!.status === "done", "실패 뒤 요청도 처리된다(중단하지 않는다)");
    assert(calls.deploys === 1 && calls.notified.length === 1, "실패가 섞여도 배포 1회·알림 1통");
    assert(calls.notified[0].includes("❌"), "알림에 실패 줄");
    assert(calls.notified[0].includes("이미지 수정"), "실패하면 재수집 안내를 붙인다");
    console.log("✅ 한 건 실패 - 나머지는 계속, 사유는 큐와 알림에 남는다");
  }

  // ④ 드레인 중 들어온 요청을 같은 run이 집는다
  {
    const { deps, calls } = makeWorld();
    const { queue, rows, reads } = makeQueue([item(1, 1, 2, old(1))], (round, push) => {
      // 첫 바퀴를 다 돈 뒤(= 두 번째 읽기 직전) 7번 자리 요청이 들어왔다.
      if (round === 1) push(item(5, 7, 3, old(7)));
    });
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: old(1) }, deps, queue });

    assert(out.results.length === 2, `두 바퀴에 2건 (${JSON.stringify(out.results)})`);
    assert(out.results.map((r) => r.slotIndex).join() === "1,7", "늦게 들어온 요청도 같은 run이 처리");
    assert(rows.get("req-5")!.status === "done", "늦게 들어온 행도 done");
    assert(reads.length >= 3, `빈 큐를 확인할 때까지 다시 읽는다 (읽기 ${reads.length}회)`);
    assert(calls.deploys === 1 && calls.notified.length === 1, "여러 바퀴를 돌아도 배포 1회·알림 1통");
    console.log("✅ 드레인 중 들어온 요청을 같은 run이 집는다");
  }

  // ⑥ 큐가 비어 있으면 아무것도 하지 않고 진행 중 표식만 풀어 준다
  {
    const { deps, calls } = makeWorld();
    const { queue } = makeQueue([]);
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: old(1) }, deps, queue });
    assert(out.results.length === 0 && out.deploys === 0 && out.notifications === 0, "할 일이 없으면 배포도 알림도 없다");
    assert(calls.deploys === 0 && calls.notified.length === 0, "앞 run이 이미 알렸다 - 두 번 알리지 않는다");
    const released = calls.metadataPatches.some((p) => IMAGE_PICK_PENDING_KEY in p && p[IMAGE_PICK_PENDING_KEY] === null);
    assert(released, "enqueue가 쓴 진행 중 표식을 풀어 준다 - 안 풀면 발행 폴러가 10분 동안 이 원고를 집지 않는다");
    console.log("✅ 빈 큐 - 조용히 끝내고 진행 중 표식을 풀어 준다");
  }

  // ⑦ 테이블이 없으면 옛 경로(단건)로 떨어진다
  {
    const { deps, calls } = makeWorld();
    const queue: ImagePickQueue = {
      listPending: async () => {
        throw new ImagePickQueueUnavailableError("image_pick_requests 테이블이 없습니다");
      },
      markProcessed: async () => {
        throw new Error("호출되면 안 된다");
      },
    };
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 3, candidateNumber: 2, fromUrl: old(3) }, deps, queue });
    assert(out.mode === "single", `migration 적용 전에는 단건 경로 (${out.mode})`);
    assert(out.results.length === 1 && out.results[0].status === "applied", "payload 한 건이 그대로 적용된다");
    assert(calls.deploys === 1 && calls.notified.length === 1, "옛 동작대로 건당 배포·알림");
    assert(calls.notified[0].includes("3번 이미지를 후보 2번으로"), `옛 단건 문구 (${calls.notified[0]})`);

    assert(isQueueTableMissing({ code: "42P01", message: "relation 'image_pick_requests' does not exist" }), "42P01은 테이블 없음");
    assert(isQueueTableMissing({ code: "PGRST205", message: "Could not find the table 'public.image_pick_requests' in the schema cache" }), "PGRST205도 테이블 없음");
    assert(!isQueueTableMissing({ code: "23505", message: "duplicate key" }), "다른 오류는 테이블 없음이 아니다");
    assert(!isQueueTableMissing(null), "오류가 없으면 false");
    console.log("✅ 테이블이 없으면 옛 경로(단건)로 떨어진다 - 적용 전 병합이 안전하다");
  }

  // 상한: 한 run이 처리할 건수에 뚜껑이 있고, 남은 건수는 알림에 적힌다
  {
    const { deps, calls } = makeWorld();
    const many = [1, 3, 7].map((slot, i) => item(i + 1, slot, 2, old(slot)));
    const { queue, rows } = makeQueue(many);
    const out = await drainImagePicks({ request: { jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: old(1) }, deps, queue, maxItems: 2 });
    assert(out.results.length === 2 && out.remaining === 1, `상한에 걸리면 남겨 둔다 (${JSON.stringify(out)})`);
    assert(out.results.every((r) => r.status === "applied"), "상한 안의 건은 정상 적용");
    assert([...rows.values()].filter((r) => r.status === "pending").length === 1, "남은 행은 pending으로 남아 다음 run이 집는다");
    assert(calls.notified[0].includes("1건이 남았습니다"), `남은 건수를 알린다 (${calls.notified[0]})`);
    assert(DEFAULT_MAX_ITEMS >= 3, "기본 상한이 평시 사용(2~3건)을 막으면 안 된다");
    console.log("✅ 한 run 상한 - 남은 건은 pending으로 남고 알림에 적힌다");
  }

  // 알림 문구
  {
    const results: DrainPickResult[] = [
      { slotIndex: 1, candidateNumber: 3, status: "applied" },
      { slotIndex: 3, candidateNumber: 4, status: "applied", alreadyPublished: true },
      { slotIndex: 7, candidateNumber: 2, status: "failed", error: "HTTP 403" },
      { slotIndex: 7, candidateNumber: 1, status: "skipped" },
    ];
    const text = imagePickDrainMessage("한효주", results);
    assert(text.startsWith('🖼 "한효주" 이미지 교체 결과 (4건)'), `머리줄에 키워드·건수 (${text.split("\n")[0]})`);
    assert(text.includes("7번 ← 후보 2번 ❌ HTTP 403"), "실패는 사유까지");
    assert(text.includes("이미 발행된 글에는 반영되지 않습니다"), "발행된 글이면 그 줄이 붙는다");
    const long = imagePickDrainMessage("키워드", [{ slotIndex: 1, candidateNumber: 1, status: "failed", error: "x".repeat(500) }]);
    assert(long.split("\n").every((line) => line.length <= 200), "오류가 길어도 한 줄을 넘치지 않는다");
    console.log("✅ 묶음 알림 문구");
  }

  console.log("\n✅ testDrainImagePicks 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
