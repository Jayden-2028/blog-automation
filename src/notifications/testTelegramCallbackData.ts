// callback_data 규약 테스트.
//
// 이 형식은 발송 측(sendKeywordNotification)과 수신 측(TelegramBot)이 공유하는 계약이라,
// 한쪽만 바뀌면 버튼이 조용히 동작하지 않는다. 그래서 형식 자체를 테스트로 고정한다.
//
// 파싱 쪽은 특히 방어적이어야 한다 - 수신 측은 어떤 문자열이 올지 통제할 수 없다.
// 봇이 들어 있는 대화의 오래된 메시지, 다른 기능의 버튼, 조작된 값이 모두 도착할 수 있다.

import {
  buildKeywordSelectionCallbackData,
  CALLBACK_DATA_MAX_BYTES,
  parseKeywordSelectionCallbackData,
} from "./telegramCallbackData.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ callback_data 규약 테스트 시작\n");

  // 1) 형식 고정. 이 문자열이 바뀌면 이미 발송된 메시지의 버튼이 동작하지 않는다.
  assert(
    buildKeywordSelectionCallbackData(18, 3) === "sel:18:3",
    `형식은 sel:<run_id>:<rank>여야 한다 (실제: ${buildKeywordSelectionCallbackData(18, 3)})`
  );
  console.log("✅ 형식 고정: sel:18:3");

  // 2) 왕복. build한 것을 parse하면 원래 값이 나와야 한다.
  for (const [runId, rank] of [
    [1, 1],
    [18, 10],
    [999999, 50],
  ] as const) {
    const parsed = parseKeywordSelectionCallbackData(buildKeywordSelectionCallbackData(runId, rank));
    assert(parsed?.runId === runId && parsed?.rank === rank, `왕복 실패: ${runId}/${rank} -> ${JSON.stringify(parsed)}`);
  }
  console.log("✅ build -> parse 왕복 일치");

  // 3) 64바이트 제한. 한글 키워드를 넣었다면 진작 넘었을 크기다.
  const longest = buildKeywordSelectionCallbackData(Number.MAX_SAFE_INTEGER, 999);
  assert(
    Buffer.byteLength(longest, "utf8") <= CALLBACK_DATA_MAX_BYTES,
    `최대 크기에서도 ${CALLBACK_DATA_MAX_BYTES}바이트 이하여야 한다 (실제: ${Buffer.byteLength(longest, "utf8")})`
  );
  console.log(`✅ 최댓값에서도 ${Buffer.byteLength(longest, "utf8")}바이트 (한도 ${CALLBACK_DATA_MAX_BYTES})`);

  // 4) 잘못된 입력은 예외가 아니라 null이어야 한다 - 수신 측의 정상 흐름이다.
  const rejected = [
    undefined,
    null,
    "",
    "sel",
    "sel:18",
    "sel:18:3:4",
    "other:18:3",
    "sel:abc:3",
    "sel:18:abc",
    "sel::3",
    "sel:18:",
    "sel:18:0", // rank는 1부터
    "sel: 18 : 3 ", // 공백 섞인 값
    "sel:-1:3",
    "SEL:18:3", // 대소문자 다름
    "'; drop table article_jobs; --",
  ];
  for (const input of rejected) {
    const result = parseKeywordSelectionCallbackData(input as string | undefined | null);
    assert(result === null, `거부해야 할 입력이 통과했다: ${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
  }
  console.log(`✅ 잘못된 입력 ${rejected.length}종 전부 null 반환 (예외 없음)`);

  // 5) build는 잘못된 인자에 대해 던진다 - 이쪽은 우리 코드의 버그이므로 조용히 넘기면 안 된다.
  for (const [runId, rank] of [
    [-1, 1],
    [1, 0],
    [1.5, 1],
    [1, 2.5],
  ] as const) {
    let threw = false;
    try {
      buildKeywordSelectionCallbackData(runId, rank);
    } catch {
      threw = true;
    }
    assert(threw, `build가 던져야 할 인자를 통과시켰다: runId=${runId}, rank=${rank}`);
  }
  console.log("✅ build는 잘못된 인자에 대해 예외 발생");

  console.log("\n✅ callback_data 규약 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
