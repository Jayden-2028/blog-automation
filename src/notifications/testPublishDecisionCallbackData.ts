// publish:<action>:<jobId> 규약 테스트. 다른 콜백 파서와 **배타적**이어야 한다 - TelegramBot이
// 파서를 차례로 시도하므로 하나라도 남의 형식을 받아들이면 엉뚱한 처리가 돈다.

import {
  buildPublishDecisionCallbackData,
  parsePublishDecisionCallbackData,
  PUBLISH_ACTIONS,
} from "./publishDecisionCallbackData.js";
import { parseArticleReviewCallbackData } from "./articleReviewCallbackData.js";
import { parseResearchDecisionCallbackData } from "./researchDecisionCallbackData.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";

{
  for (const action of PUBLISH_ACTIONS) {
    const data = buildPublishDecisionCallbackData(JOB, action);
    assert(data === `publish:${action}:${JOB}`, `형식이 publish:<action>:<jobId>여야 한다 (${data})`);
    // 텔레그램 상한을 넘기면 버튼이 조용히 깨진다 - action이 늘어날 때 여기서 잡힌다.
    assert(data.length <= 64, `Telegram callback_data는 64바이트 이하여야 한다 (${action}: ${data.length})`);
    const parsed = parsePublishDecisionCallbackData(data);
    assert(parsed?.jobId === JOB && parsed.action === action, `왕복이 깨지면 안 된다 (${action})`);
  }
  assert(buildPublishDecisionCallbackData(JOB) === `publish:blogspot:${JOB}`, "기본 action은 blogspot이어야 한다");
  console.log("✅ 왕복 + 64바이트 제한 (action 3종)");
}

{
  // 하위 호환: 2026-09-22 이전에 보낸 알림에는 `publish:<jobId>`가 박혀 있고 텔레그램 메시지는
  // 고칠 수 없다. 사용자가 옛 버튼을 눌러도 죽으면 안 된다.
  const legacy = parsePublishDecisionCallbackData(`publish:${JOB}`);
  assert(legacy?.jobId === JOB, "옛 형식도 읽어야 한다");
  assert(legacy?.action === "blogspot", "옛 형식은 Blogspot 발행으로 읽어야 한다(그때는 그 버튼뿐이었다)");
  console.log("✅ 옛 형식(publish:<jobId>)은 blogspot으로 읽는다");
}

{
  let threw = false;
  try {
    buildPublishDecisionCallbackData("job-1");
  } catch {
    threw = true;
  }
  assert(threw, "UUID가 아니면 만들 때 막아야 한다");
  for (const bad of [
    "",
    null,
    undefined,
    "publish",
    "publish:not-a-uuid",
    `publish:${JOB}:extra`,
    `publish:모르는동작:${JOB}`,
    `publish:blogspot:${JOB}:extra`,
    `review:confirm:${JOB}`,
  ]) {
    assert(parsePublishDecisionCallbackData(bad as string) === null, `잘못된 값은 null이어야 한다 (${bad})`);
  }
  console.log("✅ 잘못된 형식은 만들 때 예외, 읽을 때 null");
}

{
  // 배타성: 발행 콜백을 다른 파서가 집으면 안 되고, 그 반대도 안 된다.
  // action이 생기면서 review(3토막)와 모양이 같아졌으므로 여기가 특히 중요하다.
  for (const action of PUBLISH_ACTIONS) {
    const data = buildPublishDecisionCallbackData(JOB, action);
    assert(parseArticleReviewCallbackData(data) === null, `검수 파서가 발행 콜백을 집으면 안 된다 (${action})`);
    assert(parseResearchDecisionCallbackData(data) === null, `조사 파서가 발행 콜백을 집으면 안 된다 (${action})`);
  }
  assert(parsePublishDecisionCallbackData(`review:confirm:${JOB}`) === null, "발행 파서가 검수 콜백을 집으면 안 된다");
  assert(parsePublishDecisionCallbackData(`research:write:${JOB}`) === null, "발행 파서가 조사 콜백을 집으면 안 된다");
  console.log("✅ 다른 콜백 규약과 배타적");
}

console.log("\n🎉 publishDecisionCallbackData 테스트 통과");
