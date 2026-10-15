// computeSaturation / computeOpportunityRatio 순수 함수 테스트.
// 2026-10-16에 들어간 두 하한(수요 하한 A · 희소 하한 B)의 불변식을 고정한다.
// 근거는 config/keywordCompetition.ts의 minDemandPercentile / thinTotalThreshold 주석에 있다.

import { BLOG_COMPETITION_CONFIG } from "../../config/keywordCompetition.js";
import { computeOpportunityRatio, computeSaturation } from "./computeCompetitionScore.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 하한이 없던 시절의 설정(회귀 비교용). 두 값을 빼면 기존 공식 그대로여야 한다.
const LEGACY = {
  lowTotalThreshold: 100,
  highTotalThreshold: 100000,
  neutralScoreRatio: 0.5,
};

function main(): void {
  console.log("▶ computeCompetitionScore 테스트 시작\n");

  // ---------- 포화도 ----------
  assert(computeSaturation(50) === 0, "하한 이하는 포화도 0");
  assert(computeSaturation(200000) === 1, "상한 이상은 포화도 1");
  assert(computeSaturation(null) === null, "측정 실패는 null");
  const mid = computeSaturation(1000)!;
  assert(mid > 0.3 && mid < 0.4, `1,000건은 log10 보간으로 0.33 근처여야 한다 (실제 ${mid})`);
  console.log("✅ 포화도 log10 정규화");

  // ---------- 기존 공식(하한 없음) ----------
  assert(computeOpportunityRatio(null, 0.9, LEGACY) === 0.5, "측정 실패는 중립값");
  const legacyThin = computeOpportunityRatio(60, 0.9, LEGACY);
  assert(legacyThin === 0.9, `하한이 없으면 60건은 가점 최대였다 (실제 ${legacyThin})`);
  console.log("✅ 하한을 빼면 기존 공식 그대로");

  // ---------- (A) 수요 하한 ----------
  // run #158 3위 "스틸시리즈 센세이"의 수요 백분위가 0.21이었다. 그 구간은 이제 가점이 없다.
  assert(BLOG_COMPETITION_CONFIG.minDemandPercentile === 0.3, "이 테스트는 수요 하한 0.3 전제다");
  assert(
    computeOpportunityRatio(149, 0.21) === 0,
    "수요 백분위 0.21(스틸시리즈)은 아무리 희소해도 가점 0이어야 한다"
  );
  assert(
    computeOpportunityRatio(149, 0.21, LEGACY) > 0.19,
    "같은 입력이 하한 없을 때는 가점을 받았다는 대조"
  );
  assert(computeOpportunityRatio(1000, 0.31) > 0, "하한을 넘기면 정상적으로 가점을 받는다");
  console.log("✅ (A) 수요 하한: 배치 하위 30%는 희소해도 가점 없음");

  // ---------- (B) 희소 하한 ----------
  assert(BLOG_COMPETITION_CONFIG.thinTotalThreshold === 100, "이 테스트는 희소 하한 100건 전제다");
  const thin = computeOpportunityRatio(60, 0.9);
  const normal = computeOpportunityRatio(150, 0.9);
  assert(thin === 0.45, `60건(희소 하한 이하)은 가점이 절반으로 깎여야 한다 (실제 ${thin})`);
  assert(normal > thin, `150건이 60건보다 기회도가 높아야 한다 (${normal} vs ${thin})`);
  console.log("✅ (B) 희소 하한: 100건 미만은 '선점 기회'가 아니라 '수요 부재 의심'으로 반감");

  // ---------- 방향 불변식 ----------
  // 하한을 넣어도 "포화될수록 불리하다"는 큰 방향은 유지돼야 한다.
  const sparse = computeOpportunityRatio(300, 0.9);
  const saturated = computeOpportunityRatio(80000, 0.9);
  assert(sparse > saturated, `희소(300건)가 포화(80,000건)보다 유리해야 한다 (${sparse} vs ${saturated})`);
  console.log("✅ 방향 불변식: 포화될수록 불리하다는 기조는 그대로");

  console.log("\n✅ 전체 통과");
}

main();
