// 파이프라인 통합 게이트 테스트(PIPELINE-MERGE-2026-10.md §2). 실행: npm run test:pipeline-gate
import { isAutoApproved, parseSkipDraftReview, shouldSkipDraftReview, shouldSkipEnglishReview } from "./pipelineGate.js";

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
assert(!shouldSkipDraftReview(kscene, {}), "사용설명서 트랙은 한글 초안 승인을 남긴다(게이트와 무관)");
assert(!shouldSkipDraftReview(ent, { PIPELINE_SKIP_DRAFT_REVIEW: "false" }), "게이트 false면 옛 흐름");
assert(!shouldSkipDraftReview(social, { PIPELINE_SKIP_DRAFT_REVIEW: "false" }), "게이트 false면 사회도 옛 흐름");
console.log("✅ shouldSkipDraftReview - 트랙·게이트 조합");

assert(shouldSkipEnglishReview(kscene, {}), "사용설명서는 기본으로 영어본 단독 재승인을 건너뛴다");
assert(!shouldSkipEnglishReview(kscene, { PIPELINE_SKIP_DRAFT_REVIEW: "false" }), "게이트 false면 영어 재승인 복귀");
assert(!shouldSkipEnglishReview(ent, {}) && !shouldSkipEnglishReview(social, {}), "엔터·사회에는 영어 단계가 없다");
console.log("✅ shouldSkipEnglishReview - 사용설명서 전용");

// 🌏 국제(변환기 → kscene, 2026-10-29): metadata.source가 변환기여도 track=kscene이면 Go 버튼 job과 같은 게이트.
const ksceneConverter = { metadata: { source: "keyword_input", track: "kscene", sourceText: "본문" } };
assert(!shouldSkipDraftReview(ksceneConverter, {}) && shouldSkipEnglishReview(ksceneConverter, {}), "변환기 kscene job: 한글 초안 승인 유지 + 영어본 단독 재승인 생략");
assert(!shouldSkipEnglishReview({ metadata: { source: "keyword_input", track: "tech" } }, {}), "변환기 테크 job은 영어 단계 없음(불변)");
console.log("✅ 변환기 출처 kscene job 게이트");

assert(isAutoApproved({ metadata: { autoApprovedAt: "2026-10-08T00:00:00Z" } }), "autoApprovedAt이 있으면 자동 승인");
assert(!isAutoApproved({ metadata: {} }) && !isAutoApproved({ metadata: { autoApprovedAt: null } }), "없거나 null이면 아님");
assert(!isAutoApproved({ metadata: undefined as never }), "metadata가 없어도 던지지 않는다");
console.log("✅ isAutoApproved");
console.log("\n✅ testPipelineGate 전체 통과");
