// Cloudflare Worker의 scheduled() 핸들러가 "깨어남을 기록하고, 실패하면 던지는지" 검사한다.
//
// 왜 필요한가: 2026-10-02 엔터·커뮤니티 cron이 이틀 동안 안 돌았는데 원인을 사후에 볼 수 없었다.
// dispatch 실패가 console.error만 하고 조용히 끝나 Cloudflare에도 "성공한 호출"로 기록됐고,
// 로그 보관도 꺼져 있었다. 고친 동작(매 호출을 [cron]으로 남김 + 실패는 던짐)이 실제로 그렇게
// 움직이는지 fetch를 가짜로 바꿔 확인한다. `npm run build`는 cloudflare/를 타입 검사하지 않으므로
// 이 파일이 그 공백을 메운다.
//
// 실행: npx tsx scripts/testWorkerScheduled.ts  (네트워크·Cloudflare 접근 없음)

import worker from "../cloudflare/telegram-relay/src/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

type Scheduled = (event: unknown, env: unknown, ctx: unknown) => Promise<void>;
const scheduled = (worker as unknown as { scheduled: Scheduled }).scheduled;

const KW = "0 0,4,9,11,12 * * *";
const ENV = { GITHUB_OWNER: "o", GITHUB_REPO: "r", GH_DISPATCH_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s" };
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

/** fetch와 console을 가짜로 바꿔 한 번 실행하고, 호출 기록과 waitUntil 결과를 돌려준다. */
async function run(
  cron: string,
  fetchImpl: () => Promise<Response>,
  scheduledIso = "2026-10-05T00:00:00Z"
): Promise<{ bodies: string[]; urls: string[]; logs: string[]; errors: string[]; outcome: "ok" | "rejected"; threw: boolean }> {
  const urls: string[] = [];
  const bodies: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const waits: Promise<unknown>[] = [];

  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    urls.push(String(input));
    bodies.push(String(init?.body ?? ""));
    return fetchImpl();
  }) as typeof fetch;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));

  let threw = false;
  try {
    await scheduled(
      { cron, scheduledTime: Date.parse(scheduledIso) },
      ENV,
      { waitUntil: (p: Promise<unknown>) => void waits.push(p) }
    );
  } catch {
    threw = true;
  }

  let outcome: "ok" | "rejected" = "ok";
  for (const p of waits) {
    try {
      await p;
    } catch {
      outcome = "rejected";
    }
  }

  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  return { bodies, urls, logs, errors, outcome, threw };
}

async function main(): Promise<void> {
  console.log("▶ Worker scheduled() 동작 검사");

  // 1) 정상: 깨어남이 기록되고, 올바른 워크플로우를 dispatch한다.
  const okRun = await run(KW, async () => new Response(null, { status: 204 }), "2026-10-05T00:00:00Z");
  assert(okRun.logs.some((l) => l.includes(`[cron] ${KW}`) && l.includes("entertainment-keyword.yml")),
    "깨어남이 [cron] 한 줄로 남아야 한다(어느 cron이 어느 워크플로우로 매핑됐는지 포함)");
  assert(okRun.urls.length === 1 && okRun.urls[0].includes("/workflows/entertainment-keyword.yml/dispatches"),
    "00 UTC는 entertainment-keyword.yml을 dispatch해야 한다");
  assert(okRun.logs.some((l) => l.includes("workflow_dispatch 성공")), "성공도 한 줄 남아야 한다");
  assert(okRun.outcome === "ok" && !okRun.threw, "성공은 던지지 않아야 한다");
  console.log("  ✅ 정상: 깨어남 기록 + 올바른 워크플로우 + 성공 기록");

  // 2) 발화 시각(UTC hour)별로 맞는 워크플로우+회차 입력으로 간다.
  for (const [iso, file, round] of [
    ["2026-10-05T00:00:00Z", "entertainment-keyword.yml", "morning"],
    ["2026-10-05T04:00:00Z", "entertainment-keyword.yml", "noon"],
    ["2026-10-05T09:00:00Z", "entertainment-keyword.yml", "evening"],
    ["2026-10-05T11:00:00Z", "social-issue-keyword.yml", undefined],
  ] as const) {
    const r = await run(KW, async () => new Response(null, { status: 204 }), iso);
    assert(r.urls.length === 1 && r.urls[0].includes(`/${file}/`), `${iso}은 ${file}로 가야 한다 (실제: ${r.urls.join(",")})`);
    const body = JSON.parse(r.bodies[0]) as { ref: string; inputs?: { round?: string } };
    assert(body.inputs?.round === round, `${iso}의 round 입력은 ${round}여야 한다 (실제: ${r.bodies[0]})`);
  }
  const idle = await run(KW, async () => new Response(null, { status: 204 }), "2026-10-05T12:00:00Z");
  assert(!idle.threw && idle.urls.length === 0, "12 UTC(사용설명서 미구현)는 던지지도 호출하지도 않는다");
  console.log("  ✅ 09/13/18시=엔터 회차, 20시=사회, 21시=대기");

  // 3) GitHub가 거절하면(토큰 만료·권한 등) 던져서 오류로 남긴다. 전에는 조용히 끝났다.
  const forbidden = await run(KW, async () => new Response("Resource not accessible", { status: 403 }));
  assert(forbidden.outcome === "rejected", "dispatch가 403이면 던져야 한다 - 조용히 끝나면 실패 흔적이 안 남는다");
  assert(forbidden.errors.some((e) => e.includes("403")), "실패 사유(상태 코드)가 로그에 남아야 한다");
  console.log("  ✅ dispatch 거절(403) → 오류로 던짐 + 사유 기록");

  // 4) 네트워크 오류도 마찬가지다.
  const down = await run(KW, async () => {
    throw new Error("network down");
  });
  assert(down.outcome === "rejected", "네트워크 오류도 던져야 한다");
  console.log("  ✅ 네트워크 오류 → 오류로 던짐");

  // 5) 매핑에 없는 cron은 깨어남이 기록되고 던진다.
  const unknown = await run("0 5 * * *", async () => new Response(null, { status: 204 }));
  assert(unknown.threw, "매핑에 없는 cron은 던져야 한다");
  assert(unknown.logs.some((l) => l.includes("매핑 없음")), "매핑이 없다는 사실이 기록돼야 한다");
  assert(unknown.urls.length === 0, "매핑이 없으면 GitHub를 호출하면 안 된다");
  console.log("  ✅ 알 수 없는 cron → 기록 + 던짐 + GitHub 호출 없음");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
