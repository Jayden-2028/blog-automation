// Cloudflare Worker의 scheduled() 핸들러가 "깨어남을 기록하고, 올바른 워크플로를 깨우고,
// 흔들리면 다시 던져보고, 끝까지 실패하면 던지는지" 검사한다.
//
// 왜 필요한가: 2026-10-02 엔터·커뮤니티 cron이 이틀 동안 안 돌았는데 원인을 사후에 볼 수 없었다.
// dispatch 실패가 console.error만 하고 조용히 끝나 Cloudflare에도 "성공한 호출"로 기록됐고,
// 로그 보관도 꺼져 있었다. 고친 동작(매 호출을 [cron]으로 남김 + 실패는 던짐)이 실제로 그렇게
// 움직이는지 fetch를 가짜로 바꿔 확인한다. `npm run build`는 cloudflare/를 타입 검사하지 않으므로
// 이 파일이 그 공백을 메운다.
//
// 2026-11-04: 시각 표를 **코드에서 가져오게** 고쳤다. 전에는 cron 문자열과 시각별 기대값을 이 파일에
// 베껴 적어 뒀는데, 10/05 개편(cron 표현식 교체)과 10/11 개편(엔터 1회차화) 뒤로 그 사본이 낡아
// 이 테스트가 **한 달 내내 첫 단정에서 실패**하고 있었다. 지금은 KEYWORD_CRON을 import하고 시각별
// 기대값만 명시해, cron 문자열이 바뀌어도 테스트가 따라온다.
//
// 실행: npx tsx scripts/testWorkerScheduled.ts  (네트워크·Cloudflare 접근 없음)

import worker from "../cloudflare/telegram-relay/src/index.js";
import { KEYWORD_CRON } from "../cloudflare/telegram-relay/src/schedule.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

type Scheduled = (event: unknown, env: unknown, ctx: unknown) => Promise<void>;
const scheduled = (worker as unknown as { scheduled: Scheduled }).scheduled;

const KW = KEYWORD_CRON;
const ENV = { GITHUB_OWNER: "o", GITHUB_REPO: "r", GH_DISPATCH_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s" };
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realLog = console.log;
const realError = console.error;

/**
 * fetch와 console을 가짜로 바꿔 한 번 실행하고, 호출 기록과 waitUntil 결과를 돌려준다.
 * fetchImpl은 **호출 회차(1부터)** 를 받는다 - 재시도 검사에서 "첫 번째만 실패" 같은 응답을 만든다.
 * setTimeout도 가짜로 바꿔 재시도 대기(2·6·12초)를 기다리지 않는다 - 간격 값이 아니라 **몇 번
 * 던지는가**가 검사 대상이다.
 */
async function run(
  cron: string,
  fetchImpl: (attempt: number) => Promise<Response>,
  scheduledIso = "2026-11-04T09:00:00Z"
): Promise<{ bodies: string[]; urls: string[]; logs: string[]; errors: string[]; outcome: "ok" | "rejected"; threw: boolean }> {
  const urls: string[] = [];
  const bodies: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const waits: Promise<unknown>[] = [];
  let calls = 0;

  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    urls.push(String(input));
    bodies.push(String(init?.body ?? ""));
    calls += 1;
    return fetchImpl(calls);
  }) as typeof fetch;
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof globalThis.setTimeout;
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
  globalThis.setTimeout = realSetTimeout;
  console.log = realLog;
  console.error = realError;
  return { bodies, urls, logs, errors, outcome, threw };
}

const ok = async (): Promise<Response> => new Response(null, { status: 204 });

async function main(): Promise<void> {
  console.log("▶ Worker scheduled() 동작 검사");

  // 1) 정상: 깨어남이 기록되고, 올바른 워크플로우를 dispatch한다.
  const okRun = await run(KW, ok);
  assert(okRun.logs.some((l) => l.includes(`[cron] ${KW}`) && l.includes("entertainment-keyword.yml")),
    "깨어남이 [cron] 한 줄로 남아야 한다(어느 cron이 어느 워크플로우로 매핑됐는지 포함)");
  assert(okRun.urls.length === 1 && okRun.urls[0].includes("/workflows/entertainment-keyword.yml/dispatches"),
    "09 UTC는 entertainment-keyword.yml을 dispatch해야 한다");
  assert(okRun.logs.some((l) => l.includes("workflow_dispatch 성공")), "성공도 한 줄 남아야 한다");
  assert(okRun.outcome === "ok" && !okRun.threw, "성공은 던지지 않아야 한다");
  console.log("  ✅ 정상: 깨어남 기록 + 올바른 워크플로우 + 성공 기록");

  // 2) 발화 시각(UTC hour)별로 맞는 워크플로우 + 회차 입력으로 간다.
  for (const [iso, files, round] of [
    ["2026-11-04T09:00:00Z", ["entertainment-keyword.yml"], "evening"],
    ["2026-11-04T10:00:00Z", ["entertainment-hot-star.yml"], undefined],
    ["2026-11-04T11:00:00Z", ["social-issue-keyword.yml"], undefined],
    ["2026-11-04T12:00:00Z", ["kscene-topic.yml", "watchdog.yml"], undefined],
  ] as const) {
    const r = await run(KW, ok, iso);
    assert(r.urls.length === files.length, `${iso}은 ${files.length}건 dispatch해야 한다 (실제: ${r.urls.length})`);
    for (const file of files) {
      assert(r.urls.some((u) => u.includes(`/workflows/${file}/dispatches`)), `${iso}은 ${file}로 가야 한다 (실제: ${r.urls.join(",")})`);
    }
    const body = JSON.parse(r.bodies[0]) as { ref: string; inputs?: { round?: string } };
    assert(body.ref === "main", `${iso}의 ref는 main이어야 한다`);
    assert(body.inputs?.round === round, `${iso}의 round 입력은 ${round}여야 한다 (실제: ${r.bodies[0]})`);
  }
  console.log("  ✅ 18시=엔터(evening), 19시=핫이슈 스타, 20시=사회, 21시=사용설명서+watchdog");

  // 3) 흔들리는 실패는 다시 던져본다(2026-11-04 GitHub 장애). 첫 호출만 500이면 두 번째에 성공한다.
  const flaky = await run(KW, async (attempt) => (attempt === 1 ? new Response("boom", { status: 500 }) : new Response(null, { status: 204 })));
  assert(flaky.urls.length === 2, `500 뒤 재시도로 2회 호출해야 한다 (실제 ${flaky.urls.length})`);
  assert(flaky.outcome === "ok" && !flaky.threw, "재시도로 성공했으면 던지지 않아야 한다");
  assert(flaky.logs.some((l) => l.includes("2/4회차")), "재시도한 회차가 로그에 남아야 한다");
  console.log("  ✅ 일시적 500 → 재시도로 성공, 회차 기록");

  // 4) 끝까지 실패하면 창을 다 쓰고(4회) 던진다. 한 번 실패가 그날 수집 전부였던 게 사고의 핵심이었다.
  const down = await run(KW, async () => new Response("still down", { status: 503 }));
  assert(down.urls.length === 4, `503이 계속되면 4회까지 던져봐야 한다 (실제 ${down.urls.length})`);
  assert(down.outcome === "rejected", "끝까지 실패하면 던져야 한다 - 조용히 끝나면 실패 흔적이 안 남는다");
  assert(down.errors.some((e) => e.includes("503")), "실패 사유(상태 코드)가 로그에 남아야 한다");
  console.log("  ✅ 계속 503 → 4회 시도 후 오류로 던짐");

  // 5) 4xx는 재시도하지 않는다. 토큰·권한·입력 문제라 같은 답이 올 뿐이고, 남은 창만 태운다.
  const forbidden = await run(KW, async () => new Response("Resource not accessible", { status: 403 }));
  assert(forbidden.urls.length === 1, `403은 재시도하지 않아야 한다 (실제 ${forbidden.urls.length}회)`);
  assert(forbidden.outcome === "rejected", "dispatch가 403이면 던져야 한다");
  assert(forbidden.errors.some((e) => e.includes("403")), "실패 사유(상태 코드)가 로그에 남아야 한다");
  console.log("  ✅ dispatch 거절(403) → 재시도 없이 즉시 오류");

  // 6) 네트워크 오류도 재시도 대상이고, 복구되면 성공으로 끝난다.
  const blip = await run(KW, async (attempt) => {
    if (attempt === 1) throw new Error("network down");
    return new Response(null, { status: 204 });
  });
  assert(blip.urls.length === 2, `네트워크 오류도 다시 던져봐야 한다 (실제 ${blip.urls.length}회)`);
  assert(blip.outcome === "ok", "복구되면 성공으로 끝나야 한다");
  const dead = await run(KW, async () => {
    throw new Error("network down");
  });
  assert(dead.urls.length === 4 && dead.outcome === "rejected", "네트워크가 끝까지 죽어 있으면 4회 시도 후 던진다");
  console.log("  ✅ 네트워크 오류 → 재시도, 끝까지 죽으면 오류로 던짐");

  // 7) 매핑에 없는 cron은 깨어남이 기록되고 던진다.
  const unknown = await run("0 5 * * *", ok);
  assert(unknown.threw, "매핑에 없는 cron은 던져야 한다");
  assert(unknown.logs.some((l) => l.includes("매핑 없음")), "매핑이 없다는 사실이 기록돼야 한다");
  assert(unknown.urls.length === 0, "매핑이 없으면 GitHub를 호출하면 안 된다");
  console.log("  ✅ 알 수 없는 cron → 기록 + 던짐 + GitHub 호출 없음");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  console.log = realLog;
  console.error = realError;
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
