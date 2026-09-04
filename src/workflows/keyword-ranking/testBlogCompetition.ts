// 블로그 경쟁도 측정(Phase A)의 순수 로직 테스트.
//
// 검증 대상 둘:
// 1) computeSaturation / computeOpportunityRatio — log10 정규화와 수요 게이트가 의도대로 동작하는지.
//    특히 "수요 낮음 + 공급 없음"(아무도 안 찾는 키워드)이 만점을 받지 않아야 한다는 것이
//    이 지표를 도입한 이유의 핵심이라 불변식으로 고정한다.
// 2) probeBlogCompetition — 개별 실패가 격리되는지, 중복/공백 키워드를 걸러내는지, 상한을 지키는지.
//    fetchTotal을 주입해 외부 API 호출 없이 검증한다.
//
// 외부 호출/DB 접근 없이 순수 함수만 검증한다. 실행: npm run test:blog-competition

import { buildCompetitionQuery } from "./buildCompetitionQuery.js";
import {
  computeOpportunityRatio,
  computeSaturation,
  describeSaturation,
} from "./computeCompetitionScore.js";
import { probeBlogCompetition } from "./probeBlogCompetition.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const CONFIG = { lowTotalThreshold: 300, highTotalThreshold: 50000, neutralScoreRatio: 0.5 };

async function main(): Promise<void> {
  console.log("▶ 블로그 경쟁도(Phase A) 테스트");

  // ---------- 1. computeSaturation ----------
  console.log("\n[1] computeSaturation");

  assert(computeSaturation(0, CONFIG) === 0, "문서 0건은 포화도 0이어야 한다");
  assert(computeSaturation(300, CONFIG) === 0, "low 임계값 이하는 포화도 0이어야 한다");
  assert(computeSaturation(50000, CONFIG) === 1, "high 임계값 이상은 포화도 1이어야 한다");
  assert(computeSaturation(999999, CONFIG) === 1, "high를 크게 넘어도 1로 clamp되어야 한다");
  assert(computeSaturation(null, CONFIG) === null, "측정 실패는 null이어야 한다");
  assert(computeSaturation(-5, CONFIG) === null, "음수는 비정상 값이므로 null이어야 한다");

  const mid = computeSaturation(3873, CONFIG); // log10 기준 300~50000의 중간 지점 근처
  assert(mid !== null && mid > 0.4 && mid < 0.6, `중간 구간이 0.4~0.6이어야 한다 (실제 ${mid})`);

  // log 스케일 불변식: 자릿수가 커질수록 단조 증가한다.
  const ascending = [500, 1000, 5000, 20000].map((total) => computeSaturation(total, CONFIG)!);
  for (let i = 1; i < ascending.length; i++) {
    assert(
      ascending[i] > ascending[i - 1],
      `문서 수가 늘면 포화도도 늘어야 한다 (${ascending[i - 1]} -> ${ascending[i]})`
    );
  }
  console.log(`   포화도 곡선: ${ascending.map((v) => v.toFixed(2)).join(" < ")}`);

  // ---------- 2. computeOpportunityRatio ----------
  console.log("\n[2] computeOpportunityRatio");

  const blueOcean = computeOpportunityRatio(50, 1, CONFIG);
  const redOcean = computeOpportunityRatio(200000, 1, CONFIG);
  assert(blueOcean > 0.9, `수요 높음 + 공급 희소는 만점에 가까워야 한다 (실제 ${blueOcean})`);
  assert(redOcean < 0.1, `수요 높음 + 포화는 최저점에 가까워야 한다 (실제 ${redOcean})`);
  assert(blueOcean > redOcean, "선점 기회가 레드오션보다 높아야 한다");

  // 이 지표를 도입한 핵심 이유: 공급이 없다고 무조건 좋은 키워드가 아니다.
  const noDemand = computeOpportunityRatio(50, 0, CONFIG);
  assert(
    noDemand === 0,
    `수요가 없으면 공급이 희소해도 0점이어야 한다 — 아무도 안 찾는 키워드 (실제 ${noDemand})`
  );
  assert(
    blueOcean > noDemand,
    "같은 공급 희소 조건에서 수요가 있는 쪽이 반드시 높아야 한다"
  );

  const unmeasured = computeOpportunityRatio(null, 1, CONFIG);
  assert(
    unmeasured === CONFIG.neutralScoreRatio,
    `측정 실패는 중립값이어야 한다 — 실패를 포화와 동일 취급하지 않는다 (실제 ${unmeasured})`
  );
  assert(unmeasured > redOcean, "측정 실패가 실제 포화보다는 유리해야 한다");
  console.log(
    `   선점 ${blueOcean.toFixed(2)} > 미측정 ${unmeasured.toFixed(2)} > 포화 ${redOcean.toFixed(2)}, 수요없음 ${noDemand.toFixed(2)}`
  );

  assert(describeSaturation(null) === "측정실패", "등급 표기: null은 측정실패");
  assert(describeSaturation(0.1) === "희소", "등급 표기: 0.1은 희소");
  assert(describeSaturation(0.95) === "포화", "등급 표기: 0.95는 포화");

  // ---------- 3. probeBlogCompetition ----------
  console.log("\n[3] probeBlogCompetition");

  const calls: string[] = [];
  const fakeTotals: Record<string, number> = { 가: 100, 나: 2000, 다: 300000 };

  const ok = await probeBlogCompetition(["가", "나", "다"], {
    requestDelayMs: 0,
    fetchTotal: async (keyword) => {
      calls.push(keyword);
      return fakeTotals[keyword] ?? null;
    },
  });
  assert(ok.status === "success", `전건 성공이면 status=success (실제 ${ok.status})`);
  assert(ok.probedCount === 3, `3건을 조회해야 한다 (실제 ${ok.probedCount})`);
  assert(ok.totalByKeyword.get("나") === 2000, "조회 결과가 키워드별로 매핑되어야 한다");

  // 개별 실패 격리: 한 건이 던져도 나머지는 살아야 한다.
  const partial = await probeBlogCompetition(["가", "나", "다"], {
    requestDelayMs: 0,
    fetchTotal: async (keyword) => {
      if (keyword === "나") throw new Error("boom");
      return fakeTotals[keyword] ?? null;
    },
  });
  assert(partial.status === "partial", `일부 실패면 status=partial (실제 ${partial.status})`);
  assert(partial.failedCount === 1, `실패 1건이어야 한다 (실제 ${partial.failedCount})`);
  assert(partial.totalByKeyword.get("나") === null, "실패한 키워드는 null로 남아야 한다");
  assert(partial.totalByKeyword.get("다") === 300000, "실패 뒤 키워드도 계속 조회되어야 한다");
  assert(partial.errors["나"].includes("boom"), "실패 사유가 보존되어야 한다");

  const allFailed = await probeBlogCompetition(["가", "나"], {
    requestDelayMs: 0,
    fetchTotal: async () => {
      throw new Error("down");
    },
  });
  assert(allFailed.status === "failed", `전건 실패면 status=failed (실제 ${allFailed.status})`);

  // 중복/공백 제거 + 상한.
  const deduped = await probeBlogCompetition(["가", "가", "  ", "나"], {
    requestDelayMs: 0,
    fetchTotal: async () => 1,
  });
  assert(deduped.probedCount === 2, `중복/공백 제거 후 2건이어야 한다 (실제 ${deduped.probedCount})`);

  const capped = await probeBlogCompetition(["가", "나", "다"], {
    requestDelayMs: 0,
    maxKeywords: 2,
    fetchTotal: async () => 1,
  });
  assert(capped.probedCount === 2, `상한 2를 지켜야 한다 (실제 ${capped.probedCount})`);

  const empty = await probeBlogCompetition([], { requestDelayMs: 0, fetchTotal: async () => 1 });
  assert(empty.status === "skipped", `빈 입력은 skipped여야 한다 (실제 ${empty.status})`);

  console.log("   실패 격리 / 중복 제거 / 상한 / 빈 입력 처리 확인");

  // ---------- 4. buildCompetitionQuery ----------
  // run #32~34 Top 10 실측에서 나온 실제 키워드로 고정한다. canonical keyword를 그대로 조회하면
  // 같은 이슈가 표현 차이만으로 385배(3,081 vs 8) 갈렸다 - 그 회귀를 막는 것이 이 테스트의 목적이다.
  console.log("\n[4] buildCompetitionQuery (실측 키워드 회귀)");

  const fireworksA = buildCompetitionQuery("2026 여의도 불꽃축제 일정·시간·명당·교통통제");
  const fireworksB = buildCompetitionQuery("2026 여의도 불꽃축제 시간 헷갈리면 손해! 일정·명당·귀가");
  assert(
    fireworksA === fireworksB,
    `같은 행사는 같은 질의여야 한다 (실제 "${fireworksA}" vs "${fireworksB}")`
  );
  assert(
    fireworksA === "여의도 불꽃축제",
    `핵심 명사 2개만 남아야 한다 (실제 "${fireworksA}")`
  );
  console.log(`   불꽃축제 두 표현 -> 동일 질의 "${fireworksA}"`);

  const fallA = buildCompetitionQuery("가해자 누나는 드라마 출연 중 부산 오피스텔 추락사");
  const fallB = buildCompetitionQuery("내 딸은 죽었는데 부산 오피스텔 추락사 유족 에");
  console.log(`   추락사 두 표현 -> "${fallA}" / "${fallB}"`);

  // 연도/회차 같은 숫자 시작 토큰은 주제를 가리키지 않으므로 앞자리를 차지하면 안 된다.
  const subsidy = buildCompetitionQuery("4차 민생지원금 추석 전 신청 일정과 지급 지역은");
  assert(!subsidy.startsWith("4차"), `숫자 토큰이 앞에 오면 안 된다 (실제 "${subsidy}")`);
  assert(subsidy.includes("민생지원금"), `핵심 명사가 남아야 한다 (실제 "${subsidy}")`);
  console.log(`   "4차 민생지원금 ..." -> "${subsidy}"`);

  // 범용 수식어만으로 이루어진 입력은 축약할 게 없으므로 원문을 그대로 쓴다(측정 포기보다 낫다).
  const genericOnly = buildCompetitionQuery("결말 해석");
  assert(genericOnly.length > 0, "핵심 명사가 없어도 빈 문자열을 반환하면 안 된다");

  // 분류어(넷플릭스 등)는 걷어내지 않는다 - 경쟁도 측정에서는 오히려 필요한 한정어다.
  const ottQuery = buildCompetitionQuery("넷플릭스 들쥐 출연진 총정리");
  assert(
    ottQuery.includes("넷플릭스"),
    `분류어는 경쟁도 질의에 남아야 한다 (실제 "${ottQuery}")`
  );
  console.log(`   "넷플릭스 들쥐 출연진 총정리" -> "${ottQuery}"`);

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
