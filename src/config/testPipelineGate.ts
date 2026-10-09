// 파이프라인 통합 게이트 테스트(PIPELINE-MERGE-2026-10.md §2). 실행: npm run test:pipeline-gate
import { isAutoApproved, parseSkipDraftReview, shouldSkipDraftReview } from "./pipelineGate.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 기본값은 켜짐 - 미설정·빈 값(워크플로가 vars.X를 비워 넘기는 경우)도 켜짐.
assert(parseSkipDraftReview(undefined) === true, "미설정이면 켜짐");
assert(parseSkipDraftReview("") === true && parseSkipDraftReview("  ") === true, "빈 값이면 켜짐");
assert(parseSkipDraftReview("true") === true && parseSkipDraftReview("1") === true, "true/1은 켜짐");
for (const off of ["false", "FALSE", " False ", "0", "off", "no"]) assert(parseSkipDraftReview(off) === false, `${off}는 꺼짐`);
console.log("✅ 환경변수 해석 - 기본 켜짐, false/0/off/no만 끔");

const ent = { metadata: {} };
const social = { metadata: { track: "social" } };
const kscene = { metadata: { track: "kscene" } };
assert(shouldSkipDraftReview(ent, {}) && shouldSkipDraftReview(social, {}), "엔터·사회는 기본으로 초안 승인을 건너뛴다");
assert(!shouldSkipDraftReview(kscene, {}), "사용설명서 트랙은 게이트와 무관하게 옛 흐름(개편3 몫)");
assert(!shouldSkipDraftReview(ent, { PIPELINE_SKIP_DRAFT_REVIEW: "false" }), "게이트 false면 옛 흐름");
assert(!shouldSkipDraftReview(social, { PIPELINE_SKIP_DRAFT_REVIEW: "false" }), "게이트 false면 사회도 옛 흐름");
console.log("✅ shouldSkipDraftReview - 트랙·게이트 조합");

assert(isAutoApproved({ metadata: { autoApprovedAt: "2026-10-08T00:00:00Z" } }), "autoApprovedAt이 있으면 자동 승인");
assert(!isAutoApproved({ metadata: {} }) && !isAutoApproved({ metadata: { autoApprovedAt: null } }), "없거나 null이면 아님");
assert(!isAutoApproved({ metadata: undefined as never }), "metadata가 없어도 던지지 않는다");
console.log("✅ isAutoApproved");
console.log("\n✅ testPipelineGate 전체 통과");
