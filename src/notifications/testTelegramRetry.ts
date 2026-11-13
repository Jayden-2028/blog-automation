// 텔레그램 전송 재시도 테스트. 외부 호출 없음 - fetch를 가짜로 바꿔 돌린다.
// 실행: npm run test:telegram-retry
//
// 막으려는 사고(2026-11-13 run 43413609001): 사회 키워드 수집이 저장까지 다 끝내고 마지막
// `notify`에서 5.4초 만에 `fetch failed`로 죽어 **그날 Go/Pass 알림이 통째로 날아갔다.**
// 사람이 수집을 처음부터 다시 돌려야 했다(3분 23초).
import { sendTelegramWithRetry, TELEGRAM_RETRY_DELAYS_MS } from "./telegramRetry.js";
import { TelegramNotifier } from "./TelegramNotifier.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** 잠들지 않는다 - 테스트가 20초를 기다릴 이유가 없다. 기다린 ms만 기록한다. */
function fakeSleeper(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = [];
  return { slept, sleep: async (ms) => void slept.push(ms) };
}

const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (code: number): Response => new Response("nope", { status: code });

// 1) 이번 사고 그대로 - 첫 시도가 네트워크 거절, 다음 시도에서 성공.
{
  const { slept, sleep } = fakeSleeper();
  let calls = 0;
  const response = await sendTelegramWithRetry(
    "sendMessage",
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok();
    },
    { sleep, log: () => {} }
  );

  assert(calls === 2, `네트워크 거절을 다시 보내지 않았다(호출 ${calls}회) - 그날 알림이 통째로 날아간다`);
  assert(response.ok, "두 번째 시도의 성공 응답을 돌려주지 않았다");
  assert(slept.length === 1 && slept[0] === TELEGRAM_RETRY_DELAYS_MS[0], `첫 재시도 간격이 ${slept[0]}ms다`);
  console.log("✅ 네트워크가 깜빡이면 다시 보낸다(2026-11-13 사고)");
}

// 2) 4xx는 다시 보내지 않는다. 토큰·chat_id·본문 형식 문제라 같은 답이 올 뿐이고,
//    sendMessage에는 멱등 키가 없어 재시도가 중복 발송 위험만 키운다.
{
  const { slept, sleep } = fakeSleeper();
  let calls = 0;
  const response = await sendTelegramWithRetry(
    "sendMessage",
    async () => {
      calls += 1;
      return status(400);
    },
    { sleep, log: () => {} }
  );

  assert(calls === 1, `4xx를 ${calls}회 보냈다 - 다시 보내도 같은 답이 온다`);
  assert(response.status === 400, "4xx 응답을 그대로 돌려주지 않았다 - 호출자의 오류 문구가 달라진다");
  assert(slept.length === 0, "4xx인데 기다렸다");
  console.log("✅ 4xx는 즉시 포기하고 그 응답을 그대로 돌려준다");
}

// 3) 5xx·429·408은 다시 보낸다(텔레그램 쪽 일시 장애).
for (const code of [429, 500, 502, 408]) {
  const { sleep } = fakeSleeper();
  let calls = 0;
  await sendTelegramWithRetry(
    "sendMessage",
    async () => {
      calls += 1;
      return calls === 1 ? status(code) : ok();
    },
    { sleep, log: () => {} }
  );
  assert(calls === 2, `HTTP ${code}를 다시 보내지 않았다`);
}
console.log("✅ 429·5xx·408은 다시 보낸다");

// 4) 끝까지 실패하면 **마지막 오류를 던진다** - 호출자(알림 단계)의 기존 실패 처리가 그대로 돈다.
//    재시도가 실패를 삼켜 "성공한 척" 끝나면 조용한 실패가 된다.
{
  const { slept, sleep } = fakeSleeper();
  let calls = 0;
  let thrown: unknown;
  try {
    await sendTelegramWithRetry(
      "sendMessage",
      async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      { sleep, log: () => {} }
    );
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof Error, "끝까지 실패했는데 던지지 않았다 - 실패가 조용히 묻힌다");
  assert((thrown as Error).message.includes("fetch failed"), "마지막 오류가 아니라 다른 오류를 던졌다");
  assert(calls === TELEGRAM_RETRY_DELAYS_MS.length + 1, `시도 횟수가 ${calls}회다(간격 수 + 1이어야 한다)`);
  assert(
    slept.join(",") === TELEGRAM_RETRY_DELAYS_MS.join(","),
    `간격이 ${slept.join(",")}다 - dispatchWorkflow와 같은 2·6·12초여야 한다`
  );
  console.log("✅ 끝까지 실패하면 마지막 오류를 그대로 던진다(조용한 실패가 아니다)");
}

// 5) **로그에 봇 토큰이 절대 들어가면 안 된다.** 텔레그램 API URL에는 토큰이 들어 있어서,
//    재시도 로그에 URL을 찍으면 run 로그에 자격증명이 남는다.
{
  const { sleep } = fakeSleeper();
  const logs: string[] = [];
  const secret = "123456:AAHsecret-bot-token";
  let calls = 0;
  await sendTelegramWithRetry(
    "sendMessage",
    async () => {
      calls += 1;
      if (calls === 1) throw new Error(`fetch failed for https://api.telegram.org/bot${secret}/sendMessage`);
      return ok();
    },
    { sleep, log: (message) => void logs.push(message) }
  );

  assert(logs.length > 0, "재시도했는데 로그를 한 줄도 남기지 않았다 - 다음 사고를 못 본다");
  assert(!logs.join("\n").includes(secret), "재시도 로그에 봇 토큰이 들어갔다");
  console.log("✅ 재시도 로그에 봇 토큰이 들어가지 않는다");
}

// 6) 실제 사용처 - TelegramNotifier가 이 재시도를 **실제로 타는지** 본다(헬퍼만 고치고 연결을
//    빠뜨리면 사고는 그대로 난다). 전역 fetch를 가짜로 바꿔 호출 횟수를 센다.
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return ok();
  }) as typeof fetch;

  let failure: unknown;
  try {
    const notifier = new TelegramNotifier({ botToken: "dummy:token", chatId: "dummy-chat" });
    await notifier.send("테스트 알림");
  } catch (error) {
    // 연결이 빠지면 첫 거절이 그대로 밖으로 나온다 - 아래 단정이 이유를 설명하도록 삼킨다.
    failure = error;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert(
    failure === undefined,
    `TelegramNotifier가 첫 네트워크 거절에서 바로 죽는다 - 재시도 연결이 빠졌다(${
      failure instanceof Error ? failure.message : String(failure)
    })`
  );

  assert(calls === 2, `TelegramNotifier가 재시도를 타지 않는다(fetch ${calls}회) - 키워드 알림이 그대로 날아간다`);
  console.log("✅ TelegramNotifier(키워드 알림)가 실제로 재시도를 탄다");
}

console.log("\n✅ testTelegramRetry 전체 통과");
