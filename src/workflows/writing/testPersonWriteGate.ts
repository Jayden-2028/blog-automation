// 인물 백과 blocked write 차단 게이트 테스트(A-8). 순수 함수만 본다 - DB·LLM 없음.
import { personBlockedWriteError } from "./personWriteGate.js";
import { describeWriteFailure } from "./notifyWriteFailed.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const research = (verdict: string): string =>
  `---\nkeyword: 진선규\ncategory: person\nverdict: ${verdict}\nsource_counts: { official: 0, news: 0, community: 3 }\nresearched_at: 2026-10-13\n---\n\n## 1. 지금 화제인 이유\n(본문)\n`;

{
  const error = personBlockedWriteError("person", research("blocked"));
  assert(error !== null && /blocked/.test(error), "person + blocked는 집필을 막는다");
  assert(personBlockedWriteError("person", research("ok")) === null, "person + ok는 진행");
  assert(personBlockedWriteError("person", research("thin")) === null, "person + thin은 진행(thin 규칙은 별개)");
  assert(personBlockedWriteError("person", research("blocked # ok | thin | blocked")) !== null, "frontmatter 인라인 주석이 붙어도 blocked로 읽는다");
  for (const category of ["entertainment", "ott", "incident", "kscene", "living", null, undefined]) {
    assert(personBlockedWriteError(category, research("blocked")) === null, `${category}는 blocked여도 기존대로 verdict 무관 진행`);
  }
  assert(personBlockedWriteError("person", null) === null && personBlockedWriteError("person", "") === null, "조사 파일을 못 읽으면 막지 않는다(앞 단계 책임)");
  // 기존 실패 알림 경로가 자료 부족으로 읽고 [자료조사 다시 하기]를 붙인다.
  const described = describeWriteFailure(error, research("blocked"));
  assert(described.action === "rerun" && described.reason.includes("자료가 부족"), `기존 실패 알림이 자료 부족으로 읽어야 한다: ${JSON.stringify(described)}`);
  console.log("✅ person blocked 게이트: person만 차단, 타 카테고리 verdict 무관 유지, 기존 실패 알림(자료조사 다시 하기)과 연결");
}
