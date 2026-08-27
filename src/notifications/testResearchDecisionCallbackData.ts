// researchDecisionCallbackData 규약 테스트.

import { buildResearchDecisionCallbackData, parseResearchDecisionCallbackData } from "./researchDecisionCallbackData.js";
import { parseArticleReviewCallbackData } from "./articleReviewCallbackData.js";
import { parseKeywordSelectionCallbackData } from "./telegramCallbackData.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "054bfe0b-5cf7-4386-941f-810146c25e12";

function main(): void {
  console.log("▶ researchDecisionCallbackData 규약 테스트 시작\n");

  // 1) 형식 고정.
  assert(
    buildResearchDecisionCallbackData("write", JOB_ID) === `research:write:${JOB_ID}`,
    "write 형식이 어긋났다"
  );
  console.log("✅ 형식 고정: research:<action>:<jobId>");

  // 2) 왕복.
  for (const action of ["write", "reject"] as const) {
    const data = buildResearchDecisionCallbackData(action, JOB_ID);
    const parsed = parseResearchDecisionCallbackData(data);
    assert(parsed?.action === action && parsed.jobId === JOB_ID, `왕복 실패: ${action} -> ${JSON.stringify(parsed)}`);
  }
  console.log("✅ build -> parse 왕복 일치 (write/reject)");

  // 3) 잘못된 입력은 예외 없이 null.
  const rejected = [
    undefined,
    null,
    "",
    "research",
    "research:write",
    `research:write:${JOB_ID}:extra`,
    "sel:18:3",
    "go:18:3",
    `review:confirm:${JOB_ID}`, // review 콜백과 섞이면 안 된다
    `other:write:${JOB_ID}`,
    `research:unknown-action:${JOB_ID}`,
    "research:write:not-a-uuid",
    `RESEARCH:WRITE:${JOB_ID}`, // 대소문자
  ];
  for (const input of rejected) {
    const result = parseResearchDecisionCallbackData(input as string | undefined | null);
    assert(result === null, `거부해야 할 입력이 통과했다: ${JSON.stringify(input)}`);
  }
  console.log(`✅ 잘못된 입력 ${rejected.length}종 전부 null 반환`);

  // 4) 다른 두 콜백 파서(키워드 선택, 원고 검수)와 서로 배타적인지 교차 확인 - 세 파서가 서로의
  //    형식을 침범하면 같은 update가 이중으로 처리될 위험이 있다.
  const researchData = buildResearchDecisionCallbackData("write", JOB_ID);
  assert(parseKeywordSelectionCallbackData(researchData) === null, "research: 데이터가 키워드 선택 파서에 걸리면 안 된다");
  assert(parseArticleReviewCallbackData(researchData) === null, "research: 데이터가 원고 검수 파서에 걸리면 안 된다");
  console.log("✅ 키워드 선택/원고 검수 콜백 파서와 상호 배타적");

  // 5) UUID가 아닌 jobId로 build하면 예외를 던진다.
  let threw = false;
  try {
    buildResearchDecisionCallbackData("write", "not-a-uuid");
  } catch {
    threw = true;
  }
  assert(threw, "UUID가 아닌 jobId는 build에서 예외를 던져야 한다");
  console.log("✅ 잘못된 jobId -> build 예외 발생");

  console.log("\n✅ researchDecisionCallbackData 규약 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
