// articleReviewCallbackData 규약 테스트.

import { buildArticleReviewCallbackData, parseArticleReviewCallbackData } from "./articleReviewCallbackData.js";
import { parseKeywordSelectionCallbackData } from "./telegramCallbackData.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "054bfe0b-5cf7-4386-941f-810146c25e12";

function main(): void {
  console.log("▶ articleReviewCallbackData 규약 테스트 시작\n");

  // 1) 형식 고정.
  assert(
    buildArticleReviewCallbackData("confirm", JOB_ID) === `review:confirm:${JOB_ID}`,
    "confirm 형식이 어긋났다"
  );
  console.log("✅ 형식 고정: review:<action>:<jobId>");

  // 2) 왕복.
  for (const action of ["confirm", "edit", "discard"] as const) {
    const data = buildArticleReviewCallbackData(action, JOB_ID);
    const parsed = parseArticleReviewCallbackData(data);
    assert(parsed?.action === action && parsed.jobId === JOB_ID, `왕복 실패: ${action} -> ${JSON.stringify(parsed)}`);
  }
  console.log("✅ build -> parse 왕복 일치 (confirm/edit/discard)");

  // 3) 잘못된 입력은 예외 없이 null.
  const rejected = [
    undefined,
    null,
    "",
    "review",
    "review:confirm",
    `review:confirm:${JOB_ID}:extra`,
    "sel:18:3", // 키워드 선택 콜백과 섞이면 안 된다
    "go:18:3",
    `other:confirm:${JOB_ID}`,
    `review:unknown-action:${JOB_ID}`,
    "review:confirm:not-a-uuid",
    `REVIEW:CONFIRM:${JOB_ID}`, // 대소문자
  ];
  for (const input of rejected) {
    const result = parseArticleReviewCallbackData(input as string | undefined | null);
    assert(result === null, `거부해야 할 입력이 통과했다: ${JSON.stringify(input)}`);
  }
  console.log(`✅ 잘못된 입력 ${rejected.length}종 전부 null 반환`);

  // 4) 키워드 선택 콜백(sel/go/pass)과 겹치지 않는지 교차 확인 - 두 파서가 서로의 형식을 침범하면
  //    같은 update가 이중으로 처리될 위험이 있다.
  const reviewData = buildArticleReviewCallbackData("confirm", JOB_ID);
  assert(parseKeywordSelectionCallbackData(reviewData) === null, "review: 데이터가 키워드 선택 파서에 걸리면 안 된다");
  console.log("✅ 키워드 선택 콜백 파서와 상호 배타적");

  // 5) UUID가 아닌 jobId로 build하면 예외를 던진다(우리 코드의 버그이므로 조용히 넘기면 안 된다).
  let threw = false;
  try {
    buildArticleReviewCallbackData("confirm", "not-a-uuid");
  } catch {
    threw = true;
  }
  assert(threw, "UUID가 아닌 jobId는 build에서 예외를 던져야 한다");
  console.log("✅ 잘못된 jobId -> build 예외 발생");

  console.log("\n✅ articleReviewCallbackData 규약 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
