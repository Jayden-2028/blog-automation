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
    buildKeywordSelectionCallbackData("go", 18, 3) === "go:18:3",
    `go 형식이 어긋났다 (실제: ${buildKeywordSelectionCallbackData("go", 18, 3)})`
  );
  assert(
    buildKeywordSelectionCallbackData("pass", 18, 3) === "pass:18:3",
    `pass 형식이 어긋났다 (실제: ${buildKeywordSelectionCallbackData("pass", 18, 3)})`
  );
  console.log("✅ 형식 고정: go:18:3 / pass:18:3");

  // 1-1) 구 접두사 sel:은 go로 받아준다. 이미 발송된 메시지의 버튼이 대화에 남아 있어서,
  //      거부하면 사용자가 누른 뒤 아무 일도 일어나지 않는 것처럼 보인다.
  const legacy = parseKeywordSelectionCallbackData("sel:18:3");
  assert(
    legacy?.action === "go" && legacy.runId === 18 && legacy.rank === 3,
    `구 sel: 접두사를 go로 받아야 한다 (실제: ${JSON.stringify(legacy)})`
  );
  console.log("✅ 구 접두사 sel: -> go 별칭 유지");

  // 2) 왕복. build한 것을 parse하면 원래 값이 나와야 한다.
  for (const action of ["go", "pass"] as const) {
    for (const [runId, rank] of [
      [1, 1],
      [18, 10],
      [999999, 50],
    ] as const) {
      const parsed = parseKeywordSelectionCallbackData(buildKeywordSelectionCallbackData(action, runId, rank));
      assert(
        parsed?.action === action && parsed.runId === runId && parsed.rank === rank,
        `왕복 실패: ${action}/${runId}/${rank} -> ${JSON.stringify(parsed)}`
      );
    }
  }
  console.log("✅ build -> parse 왕복 일치 (go/pass)");

  // 3) 64바이트 제한. 한글 키워드를 넣었다면 진작 넘었을 크기다.
  const longest = buildKeywordSelectionCallbackData("pass", Number.MAX_SAFE_INTEGER, 999);
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
    "go",
    "go:18",
    "go:18:3:4",
    "other:18:3",
    "go:abc:3",
    "go:18:abc",
    "go::3",
    "go:18:",
    "go:18:0", // rank는 1부터
    "go: 18 : 3 ", // 공백 섞인 값
    "go:-1:3",
    "GO:18:3", // 대소문자 다름
    "pass:18:0",
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
      buildKeywordSelectionCallbackData("go", runId, rank);
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
