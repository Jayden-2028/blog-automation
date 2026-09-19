// publish:<jobId> 규약 테스트. 다른 콜백 파서와 **배타적**이어야 한다 - TelegramBot이 파서를
// 차례로 시도하므로 하나라도 남의 형식을 받아들이면 엉뚱한 처리가 돈다.

import { buildPublishDecisionCallbackData, parsePublishDecisionCallbackData } from "./publishDecisionCallbackData.js";
import { parseArticleReviewCallbackData } from "./articleReviewCallbackData.js";
import { parseResearchDecisionCallbackData } from "./researchDecisionCallbackData.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";

{
  const data = buildPublishDecisionCallbackData(JOB);
  assert(data === `publish:${JOB}`, `형식이 publish:<jobId>여야 한다 (${data})`);
  assert(data.length <= 64, `Telegram callback_data는 64바이트 이하여야 한다 (${data.length})`);
  assert(parsePublishDecisionCallbackData(data)?.jobId === JOB, "왕복이 깨지면 안 된다");
  console.log("✅ 왕복 + 64바이트 제한");
}

{
  let threw = false;
  try {
    buildPublishDecisionCallbackData("job-1");
  } catch {
    threw = true;
  }
  assert(threw, "UUID가 아니면 만들 때 막아야 한다");
  for (const bad of ["", null, undefined, "publish", "publish:not-a-uuid", `publish:${JOB}:extra`, `review:confirm:${JOB}`]) {
    assert(parsePublishDecisionCallbackData(bad as string) === null, `잘못된 값은 null이어야 한다 (${bad})`);
  }
  console.log("✅ 잘못된 형식은 만들 때 예외, 읽을 때 null");
}

{
  // 배타성: 발행 콜백을 다른 파서가 집으면 안 되고, 그 반대도 안 된다.
  const publishData = buildPublishDecisionCallbackData(JOB);
  assert(parseArticleReviewCallbackData(publishData) === null, "검수 파서가 발행 콜백을 집으면 안 된다");
  assert(parseResearchDecisionCallbackData(publishData) === null, "조사 파서가 발행 콜백을 집으면 안 된다");
  assert(parsePublishDecisionCallbackData(`review:confirm:${JOB}`) === null, "발행 파서가 검수 콜백을 집으면 안 된다");
  assert(parsePublishDecisionCallbackData(`research:write:${JOB}`) === null, "발행 파서가 조사 콜백을 집으면 안 된다");
  console.log("✅ 다른 콜백 규약과 배타적");
}

console.log("\n🎉 publishDecisionCallbackData 테스트 통과");
