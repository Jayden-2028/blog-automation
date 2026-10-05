// Worker fetch 핸들러의 트랙 라우팅 테스트(§3.1). 전역 fetch를 가짜로 바꿔 GitHub·텔레그램 호출을 가로챈다 -
// 네트워크·토큰 없이 "어느 봇의 토큰으로 토스트를 띄우고, dispatch payload에 track이 실리는가"를 확인한다.
import worker, { type Env } from "./index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

type Call = { url: string; body: unknown };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const env: Env = {
  TELEGRAM_WEBHOOK_SECRET: "s3cret",
  GH_DISPATCH_TOKEN: "gh",
  GITHUB_OWNER: "o",
  GITHUB_REPO: "r",
  TELEGRAM_BOT_TOKEN: "MAIN",
  SOCIAL_TELEGRAM_BOT_TOKEN: "SOCIAL",
};

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;

function callbackUpdate(): unknown {
  return { update_id: 1, callback_query: { id: "cb1", data: "kw:go:7:1", message: { message_id: 10, chat: { id: 99 } } } };
}

async function post(path: string, body: unknown, secret = "s3cret"): Promise<Response> {
  calls.length = 0;
  pending.length = 0;
  const response = await worker.fetch(
    new Request(`https://relay.example${path}`, {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );
  await Promise.all(pending);
  return response;
}

const dispatchOf = (): { client_payload: { track?: string } } =>
  calls.find((c) => c.url.endsWith("/dispatches"))!.body as { client_payload: { track?: string } };

try {
  // 1) 사회 봇 경로: dispatch에 track=social, 토스트·버튼 잠금은 **사회 봇 토큰**으로
  let res = await post("/webhook/social", callbackUpdate());
  assert(res.status === 200, `사회 경로 200 (실제 ${res.status})`);
  assert(dispatchOf().client_payload.track === "social", "dispatch payload에 track=social");
  const telegramCalls = calls.filter((c) => c.url.includes("api.telegram.org"));
  assert(telegramCalls.length === 2, `토스트 + 버튼 잠금 2건 (실제 ${telegramCalls.length})`);
  assert(telegramCalls.every((c) => c.url.includes("botSOCIAL/")), "사회 봇 콜백은 사회 봇 토큰으로 답해야 한다");
  assert(!calls.some((c) => c.url.includes("botMAIN/")), "메인봇 토큰이 쓰이면 안 된다");
  console.log("✅ /webhook/social -> track=social, 사회 봇 토큰으로 토스트·잠금");

  // 2) 루트 경로(개편 전 메인봇 webhook) -> 엔터, 메인봇 토큰
  res = await post("/", callbackUpdate());
  assert(res.status === 200 && dispatchOf().client_payload.track === "entertainment", "루트는 track=entertainment");
  assert(calls.filter((c) => c.url.includes("api.telegram.org")).every((c) => c.url.includes("botMAIN/")), "메인봇 토큰");
  console.log("✅ 루트(기존 메인봇 webhook) -> track=entertainment, 메인봇 토큰");

  // 3) update 본문의 track은 경로가 덮어쓴다(위조 방지)
  res = await post("/webhook/social", { ...(callbackUpdate() as object), track: "entertainment" });
  assert(dispatchOf().client_payload.track === "social", "본문 track이 경로를 이기면 안 된다");
  console.log("✅ 본문의 track 위조 무시");

  // 4) 모르는 경로 -> 404, dispatch 없음
  res = await post("/webhook/nope", callbackUpdate());
  assert(res.status === 404 && !calls.some((c) => c.url.endsWith("/dispatches")), "모르는 경로는 404, GitHub 호출 없음");
  console.log("✅ 모르는 트랙 경로 -> 404");

  // 5) 시크릿이 틀리면 경로와 무관하게 403
  res = await post("/webhook/social", callbackUpdate(), "wrong");
  assert(res.status === 403 && calls.length === 0, "시크릿 불일치는 403");
  console.log("✅ 시크릿 불일치 -> 403");

  // 6) 사회 봇 토큰 secret이 없으면 토스트만 생략하고 dispatch는 계속(메인봇 토큰으로 대신하지 않는다)
  const noSocial: Env = { ...env, SOCIAL_TELEGRAM_BOT_TOKEN: undefined };
  calls.length = 0;
  pending.length = 0;
  const res2 = await worker.fetch(
    new Request("https://relay.example/webhook/social", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
      body: JSON.stringify(callbackUpdate()),
    }),
    noSocial,
    ctx
  );
  await Promise.all(pending);
  assert(res2.status === 200 && calls.some((c) => c.url.endsWith("/dispatches")), "토큰이 없어도 dispatch는 간다");
  assert(!calls.some((c) => c.url.includes("api.telegram.org")), "사회 토큰이 없으면 다른 봇 토큰으로 대신 호출하지 않는다");
  console.log("✅ 사회 봇 토큰 없음 -> 토스트 생략, 메인봇 토큰으로 대체하지 않음");

  // 7) 인스타 봇: 답장이 아닌 일반 메시지(링크)도 넘긴다. 다른 봇은 여전히 안 넘긴다.
  const plain = { update_id: 2, message: { message_id: 11, chat: { id: 99 }, text: "https://www.instagram.com/p/ABC/" } };
  res = await post("/webhook/instagram", plain);
  assert(res.status === 200 && dispatchOf().client_payload.track === "instagram", "인스타 일반 메시지는 dispatch(track=instagram)");
  res = await post("/webhook/social", plain);
  assert(res.status === 200 && !calls.some((c) => c.url.endsWith("/dispatches")), "사회 봇의 일반 메시지는 그대로 무시");
  console.log("✅ 인스타 봇만 일반 메시지(링크) 전달");

  console.log("\n✅ testFetch 전체 통과");
} finally {
  globalThis.fetch = realFetch;
}
