// 구글 이미지 검색 장애 알림 테스트. 실행: npm run test:serper-outage
//
// 지켜야 할 것: ① 멀쩡할 때는 알리지 않는다 ② 자리마다 실패해도 알림은 한 번 ③ 사유가 그대로
// 실린다(크레딧 소진인지 키 오류인지는 사람이 보고 판단한다).
import { buildSerperOutageMessage, notifySerperOutage } from "./notifySerperOutage.js";
import { resetSerperOutage, searchSerperImages, takeSerperOutage } from "./searchSerperImages.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  // --- 1. 멀쩡하면 알리지 않는다 ---------------------------------------------------------------
  {
    let sent = 0;
    const notified = await notifySerperOutage({
      takeOutage: () => null,
      sendMessages: async () => { sent += 1; },
    });
    assert(notified === false && sent === 0, "장애가 없으면 알림도 없어야 한다");
    console.log("✅ 멀쩡할 때는 알리지 않는다");
  }

  // --- 2. 실패가 기록되고, 여러 번 실패해도 알림은 한 번 ------------------------------------------
  {
    resetSerperOutage();
    process.env.SERPER_API_KEY = "test-key";
    const failing = (async () =>
      new Response("Not enough credits", { status: 403 })) as unknown as typeof fetch;

    // 자리 3개가 연달아 실패하는 상황.
    for (const query of ["첫 검색어", "둘째 검색어", "셋째 검색어"]) {
      const out = await searchSerperImages(query, { fetchImpl: failing });
      assert(out.length === 0, "실패하면 빈 배열이어야 한다(수집은 네이버로 계속 간다)");
    }

    const messages: TelegramOutgoingMessage[][] = [];
    const first = await notifySerperOutage({ sendMessages: async (m) => { messages.push(m); } });
    assert(first === true && messages.length === 1, "장애가 있으면 한 번 알려야 한다");
    assert(messages[0].length === 1, `메시지는 한 건이어야 한다 (${messages[0].length}건)`);

    // 처음 실패한 검색어가 실려야 한다 - 세 번 실패했다고 세 번 알리면 안 된다.
    assert(messages[0][0].text.includes("첫 검색어"), "처음 실패한 검색어가 실려야 한다");
    assert(messages[0][0].text.includes("403"), "상태 코드가 실려야 한다");
    assert(messages[0][0].text.includes("Not enough credits"), "응답 본문이 그대로 실려야 한다");

    // 가져간 뒤에는 비워져야 한다 - 다음 실행에서 같은 장애를 또 알리면 안 된다.
    const second = await notifySerperOutage({ sendMessages: async () => { throw new Error("두 번 보내면 안 된다"); } });
    assert(second === false, "한 번 알린 장애를 또 알리면 안 된다");
    delete process.env.SERPER_API_KEY;
    console.log("✅ 자리마다 실패해도 알림은 한 번 + 사유가 그대로 실린다");
  }

  // --- 3. 키가 없으면 장애가 아니다 --------------------------------------------------------------
  // 키 미설정은 "구글을 안 쓰기로 한 상태"다. 호출도 하지 않으므로 알릴 것이 없다.
  {
    resetSerperOutage();
    delete process.env.SERPER_API_KEY;
    await searchSerperImages("검색어", {
      fetchImpl: (async () => { throw new Error("키가 없으면 호출하면 안 된다"); }) as unknown as typeof fetch,
    });
    assert(takeSerperOutage() === null, "키 미설정은 장애로 기록하면 안 된다");
    console.log("✅ 키 미설정은 장애가 아니다");
  }

  // --- 4. 메시지가 사람이 읽고 바로 행동할 수 있어야 한다 -----------------------------------------
  {
    const text = buildSerperOutageMessage({ status: 403, message: "Not enough credits", query: "지창욱 화보" }).text;
    assert(text.includes("네이버 후보만"), "지금 어떤 상태인지 알려야 한다");
    assert(text.includes("멈추지 않지만"), "장애가 아니라 품질 저하라는 점을 알려야 한다");
    assert(text.includes("serper.dev"), "무엇을 해야 하는지 알려야 한다");
    console.log("✅ 메시지 - 현재 상태 + 영향 + 할 일");
  }

  console.log("\n🎉 구글 이미지 검색 장애 알림 테스트 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
