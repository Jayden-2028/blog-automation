// Serper 사용량 계측 테스트. 외부 호출·Supabase 없음(fetch·record 주입).

import { resetSerperOutage, resetSerperRateLimit, searchSerperImages } from "./searchSerperImages.js";
import { searchKinolightsStills } from "./searchKinolightsStills.js";
import { recordSerperUsage } from "../../services/usage/recordSerperUsage.js";
import { estimateQueryCostUsd } from "../../config/apiPricing.js";
import type { RecordApiUsageInput } from "../../services/usage/recordApiUsage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB = "11111111-1111-4111-8111-111111111111";

function recorder() {
  const calls: RecordApiUsageInput[] = [];
  return { calls, record: async (input: RecordApiUsageInput) => void calls.push(input) };
}

const okImages = (async () =>
  new Response(JSON.stringify({ images: [{ imageUrl: "https://x/a.jpg", title: "a" }] }), { status: 200 })) as unknown as typeof fetch;

async function main(): Promise<void> {
  process.env.SERPER_API_KEY = "test-key";
  console.log("▶ Serper 계측 테스트 시작\n");

  // 1) 단가: 1쿼리 = $0.001, 실패 0건 = $0
  assert(estimateQueryCostUsd("serper-images", 1) === 0.001, "쿼리당 $0.001");
  assert(estimateQueryCostUsd("serper-images", 0) === 0, "0쿼리는 0(모름이 아니다)");
  assert(estimateQueryCostUsd("없는모델", 1) === null, "미등록은 null");
  console.log("  ✅ 단가");

  // 2) 성공 호출: images 1행, job_id·billedQueries 1
  {
    resetSerperRateLimit();
    const r = recorder();
    const out = await searchSerperImages("검색어", { fetchImpl: okImages, jobId: JOB, record: r.record });
    await new Promise((resolve) => setImmediate(resolve));
    assert(out.length === 1, "검색 결과는 그대로");
    assert(r.calls.length === 1, "성공 1건 = 1행");
    const c = r.calls[0];
    assert(c.provider === "serper" && c.model === "serper-images" && c.operation === "image.search", "성공 행 필드");
    assert(c.billedQueries === 1 && c.jobId === JOB && c.quantity === 1, "크레딧 1, job_id");
    console.log("  ✅ 성공 호출 기록(job_id 포함)");
  }

  // 3) 400: 실패 행(크레딧 0), 여전히 []
  {
    resetSerperRateLimit();
    resetSerperOutage();
    const r = recorder();
    const f400 = (async () => new Response("Not enough credits", { status: 400 })) as unknown as typeof fetch;
    const out = await searchSerperImages("검색어", { fetchImpl: f400, jobId: JOB, record: r.record });
    await new Promise((resolve) => setImmediate(resolve));
    assert(out.length === 0, "400이면 빈 배열");
    assert(r.calls.length === 1 && r.calls[0].operation === "image.search.failed", "400은 .failed 행");
    assert(r.calls[0].billedQueries === 0 && (r.calls[0].metadata as { status: number }).status === 400, "크레딧 0 + 상태코드");
    resetSerperOutage();
    console.log("  ✅ 400 실패 행(크레딧 0)");
  }

  // 4) 429 재시도: 시도마다 1행(429, 429, 200)
  {
    resetSerperRateLimit();
    const r = recorder();
    let n = 0;
    const flaky = (async () => {
      n += 1;
      return n < 3 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify({ images: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await searchSerperImages("검색어", { fetchImpl: flaky, jobId: JOB, record: r.record });
    await new Promise((resolve) => setImmediate(resolve));
    assert(r.calls.length === 3, "시도마다 1행");
    assert(r.calls.filter((c) => c.operation === "image.search.failed").length === 2, "429 두 번은 실패 행");
    assert(r.calls.filter((c) => c.billedQueries === 1).length === 1, "크레딧은 성공 1건만");
    console.log("  ✅ 429 재시도 시도별 기록");
  }

  // 5) 기록이 던져도(동기·비동기) 검색은 멀쩡
  {
    resetSerperRateLimit();
    const asyncThrow = async () => {
      throw new Error("db down");
    };
    const syncThrow = (() => {
      throw new Error("sync boom");
    }) as unknown as typeof import("../../services/usage/recordApiUsage.js").recordApiUsage;
    const a = await searchSerperImages("검색어", { fetchImpl: okImages, record: asyncThrow });
    const b = await searchSerperImages("검색어", { fetchImpl: okImages, record: syncThrow });
    await new Promise((resolve) => setImmediate(resolve));
    assert(a.length === 1 && b.length === 1, "기록 실패가 검색을 깨면 안 된다");
    recordSerperUsage({ endpoint: "images", ok: true, status: 200, record: asyncThrow });
    console.log("  ✅ 기록 실패(동기·비동기)가 검색에 무영향");
  }

  // 6) 키노라이츠 /search: endpoint search로 기록, job_id 전달
  {
    const r = recorder();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ organic: [{ link: "https://m.kinolights.com/season/1" }] }), { status: 200 })) as unknown as typeof fetch;
    try {
      await searchKinolightsStills("연애박사", { fetchPage: async () => null, jobId: JOB, record: r.record });
    } finally {
      globalThis.fetch = realFetch;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert(r.calls.length >= 1, "작품 페이지 검색 1건 이상 기록");
    assert(r.calls.every((c) => c.model === "serper-search" && c.operation === "web.search" && c.jobId === JOB), "search 행 필드·job_id");
    console.log("  ✅ 키노라이츠 /search 기록");
  }

  // 7) 키 없으면 호출도 기록도 없다
  {
    delete process.env.SERPER_API_KEY;
    const r = recorder();
    const out = await searchSerperImages("검색어", { fetchImpl: okImages, record: r.record });
    assert(out.length === 0 && r.calls.length === 0, "키 없음 = 호출·기록 없음");
    process.env.SERPER_API_KEY = "test-key";
    console.log("  ✅ 키 없음");
  }

  console.log("\n✅ Serper 계측 테스트 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
