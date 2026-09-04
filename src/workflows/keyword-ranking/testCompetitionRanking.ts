// rankKeywords의 경쟁도 측정/재정렬 경로 테스트.
//
// 왜 이 파일이 필요한가: 이 경로는 실서비스로 검증하지 못한 유일한 새 로직이다. 측정을 다양성
// 선정 **전에** 하도록 rankKeywords 안으로 옮겼는데(최종 Top N이 정해진 뒤에 재면 순위를 바꿀 수
// 없으므로), 그 과정에서 지켜야 할 불변식이 둘 있다:
//
// 1) applyToScore=false(기본)면 순위가 **한 칸도** 바뀌지 않아야 한다. 프로덕션이 지금 이 상태다.
//    측정은 하되 점수에는 반영하지 않으므로, 이게 깨지면 승인 없이 랭킹이 바뀐 것이다.
// 2) applyToScore=true면 포화된 키워드가 내려가고 희소한 키워드가 올라와야 한다.
//
// 두 상태를 한 프로세스에서 검증할 수 없다(config가 import 시점에 env를 읽어 모듈 캐시에 고정된다).
// 그래서 같은 파일을 env만 바꿔 두 번 돌린다 - package.json의 test:competition-ranking(off) /
// test:competition-ranking-on(on).
//
// 외부 호출 없음: 경쟁도 측정기(run)를 fake로 주입한다.

// rankKeywords는 DB를 쓰지 않지만, 같은 모듈의 다른 import(buildDailyQueryPool -> SeedQueryRepository)가
// Supabase 클라이언트를 끌고 오고 그 모듈이 import 시점에 자격증명을 요구한다. 이 테스트는 DB에
// 접근하지 않으므로 더미 값을 세우고 동적 import한다 - 실제 연결은 일어나지 않는다.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-only-not-a-real-key";

const { rankKeywords } = await import("../dailyKeywordWorkflow.js");

import type { KeywordCluster } from "./clustering/KeywordClusterer.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const APPLY = (process.env.BLOG_COMPETITION_APPLY_TO_SCORE ?? "false").toLowerCase() === "true";

function candidate(keyword: string, source: string, publishedAt: string): KeywordCandidate {
  return {
    keyword,
    category: "living",
    source,
    trendScore: 1,
    sourceUrl: null,
    publishedAt,
    metadata: { query: keyword },
  };
}

/** 같은 신호를 가진 cluster를 만든다 - 경쟁도 외의 변수를 없애기 위함. */
function cluster(keyword: string): KeywordCluster<KeywordCandidate> {
  const now = new Date().toISOString();
  return {
    representativeKeyword: keyword,
    items: [
      candidate(keyword, "naver_news", now),
      candidate(keyword, "naver_blog", now),
      candidate(keyword, "naver_web", now),
    ],
  };
}

// 포화(10만 건) / 중간(3천 건) / 희소(50건). 세 항목의 다른 신호는 동일하게 맞춰뒀다.
const SATURATED = "포화 키워드 지원금 신청 방법";
const MIDDLE = "중간 키워드 지원금 신청 방법";
const SPARSE = "희소 키워드 지원금 신청 방법";

const BLOG_TOTALS: Record<string, number> = {
  [SATURATED]: 100_000,
  [MIDDLE]: 3_000,
  [SPARSE]: 50,
};

async function main(): Promise<void> {
  console.log(`▶ 경쟁도 재정렬 테스트 (applyToScore=${APPLY})`);

  const clusters = [cluster(SATURATED), cluster(MIDDLE), cluster(SPARSE)];
  const queries = [SATURATED, MIDDLE, SPARSE];

  // 경쟁도 없이 채점한 기준선. trend API를 안 타도록 queries를 그대로 넘기면 momentum이 비어
  // 모든 항목이 같은 중립 처리를 받는다(이 테스트가 보려는 건 경쟁도 하나뿐이다).
  const baseline = await rankKeywords(clusters, queries, { topN: 3 });
  assert(baseline.competition === null, "competition을 안 넘기면 측정 결과가 null이어야 한다");
  const baselineOrder = baseline.rankings.map((r) => r.keyword);
  console.log(`   기준선 순서: ${baselineOrder.join(" > ")}`);

  let probedItems: string[] = [];
  const withCompetition = await rankKeywords(clusters, queries, {
    topN: 3,
    competition: {
      probeTopN: 30,
      run: async (items) => {
        probedItems = items.map((i) => i.keyword);
        return new Map(
          items.map((item) => [
            item.keyword,
            { query: item.keyword, total: BLOG_TOTALS[item.keyword] ?? null, source: "llm" },
          ])
        );
      },
    },
  });

  assert(withCompetition.competition !== null, "competition 결과가 있어야 한다");
  assert(probedItems.length === 3, `상위 후보 3건을 측정해야 한다 (실제 ${probedItems.length})`);
  assert(
    withCompetition.competition.applied === APPLY,
    `applied 플래그가 설정과 일치해야 한다 (실제 ${withCompetition.competition.applied})`
  );

  const entryOf = (keyword: string) =>
    withCompetition.competition!.entries.find((e) => e.keyword === keyword)!;

  // preview 값은 플래그와 무관하게 항상 채워져야 한다 - 이게 있어야 "켜면 어떻게 되는지"를 보고
  // 승인 여부를 판단할 수 있다.
  const saturatedEntry = entryOf(SATURATED);
  const sparseEntry = entryOf(SPARSE);
  assert(saturatedEntry.blogTotal === 100_000, "측정값이 entry에 담겨야 한다");
  assert(
    sparseEntry.scoreAfter > saturatedEntry.scoreAfter,
    `희소 키워드의 반영 후 점수가 포화보다 높아야 한다 ` +
      `(희소 ${sparseEntry.scoreAfter} vs 포화 ${saturatedEntry.scoreAfter})`
  );
  console.log(
    `   preview: 희소 ${sparseEntry.scoreBefore}→${sparseEntry.scoreAfter}점, ` +
      `포화 ${saturatedEntry.scoreBefore}→${saturatedEntry.scoreAfter}점`
  );

  const order = withCompetition.rankings.map((r) => r.keyword);
  console.log(`   실제 순서: ${order.join(" > ")}`);

  if (APPLY) {
    // 반영 시: 포화 키워드가 희소 키워드보다 뒤로 가야 한다.
    assert(
      order.indexOf(SPARSE) < order.indexOf(SATURATED),
      `희소 키워드가 포화 키워드보다 앞이어야 한다 (실제 ${order.join(" > ")})`
    );
    assert(
      withCompetition.rankings.find((r) => r.keyword === SATURATED)!.totalScore ===
        saturatedEntry.scoreAfter,
      "반영 시 최종 점수가 재채점 결과와 같아야 한다"
    );
    console.log("✅ 반영 시 포화 키워드가 하락하고 희소 키워드가 상승한다");
  } else {
    // **가장 중요한 불변식**: 기본 설정에서는 순위가 한 칸도 바뀌지 않는다.
    assert(
      JSON.stringify(order) === JSON.stringify(baselineOrder),
      `applyToScore=false면 순위가 기준선과 같아야 한다 (기준선 ${baselineOrder.join(">")} vs 실제 ${order.join(">")})`
    );
    for (const ranking of withCompetition.rankings) {
      const entry = entryOf(ranking.keyword);
      assert(
        ranking.totalScore === entry.scoreBefore,
        `applyToScore=false면 최종 점수가 측정 전 점수여야 한다 (${ranking.keyword})`
      );
    }
    console.log("✅ 미반영 시 순위·점수가 기준선과 동일하다 (측정만 수행)");
  }

  // 측정 실패(total=null)는 채점을 망가뜨리면 안 된다.
  const withFailure = await rankKeywords(clusters, queries, {
    topN: 3,
    competition: {
      probeTopN: 30,
      run: async (items) =>
        new Map(items.map((item) => [item.keyword, { query: item.keyword, total: null, source: "llm" }])),
    },
  });
  assert(withFailure.rankings.length === 3, "측정 실패해도 Top N이 나와야 한다");
  for (const ranking of withFailure.rankings) {
    assert(
      Number.isFinite(ranking.totalScore) && ranking.totalScore >= 0,
      `측정 실패 시에도 점수가 유효해야 한다 (${ranking.keyword}: ${ranking.totalScore})`
    );
  }
  console.log("✅ 측정 실패(null)해도 파이프라인이 유효한 결과를 낸다");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
