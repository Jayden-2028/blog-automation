// runCreatorAdvisorCollection(수집 -> 매핑 -> 저장 배선) 테스트.
// 실제 Supabase 쓰기와 실제 브라우저 실행을 모두 하지 않는다 - fetchCandidates를 주입하고
// dryRun으로 DB 접근을 막은 채, 배선/실패 격리/enabled 게이트만 검증한다.
// 다른 Creator Advisor 테스트와 동일하게 별도 프레임워크 없이 assert 헬퍼 + 콘솔 로그로 확인한다.

import {
  dedupeTrendCandidateInserts,
  mapCreatorAdvisorCandidatesToInserts,
} from "./mapCreatorAdvisorCandidates.js";
import { runCreatorAdvisorCollection } from "./runCreatorAdvisorCollection.js";
import type { FetchTrendKeywordsResult } from "../../services/search/providers/BrowserCreatorAdvisorProvider.js";
import type { CreatorAdvisorTrendCandidate } from "../../services/search/providers/CreatorAdvisorProvider.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const TREND_DATE = "2026-08-25";
const COLLECTED_AT = "2026-08-26T00:00:00.000Z";

function makeCandidate(topic: string, keyword: string, rank: number): CreatorAdvisorTrendCandidate {
  return {
    keyword,
    topic,
    rank,
    movementType: "up",
    previousRank: rank + 3,
    rankChange: 3,
    collectedAt: COLLECTED_AT,
    metadata: { trendDate: TREND_DATE },
  };
}

function makeFetchResult(candidates: CreatorAdvisorTrendCandidate[]): FetchTrendKeywordsResult {
  return {
    candidates,
    topics: [{ topic: "드라마", candidates }],
    topicErrors: {},
    trendDate: TREND_DATE,
    requestedAt: COLLECTED_AT,
    initialTrendDate: TREND_DATE,
    latestAvailableTrendDate: TREND_DATE,
    dateChecks: [],
    cardScope: { topicCardCount: 1, demographicCardCount: 0, untitledCardCount: 0 } as never,
  };
}

async function main() {
  console.log("▶ Creator Advisor Collection 배선 테스트 시작\n");

  // 1) enabled=false면 크롤링 자체를 시도하지 않아야 한다.
  let fetchCalled = false;
  const disabled = await runCreatorAdvisorCollection({
    enabled: false,
    fetchCandidates: async () => {
      fetchCalled = true;
      return makeFetchResult([]);
    },
  });
  assert(disabled.status === "skipped", "enabled=false면 status='skipped'여야 한다");
  assert(disabled.reason === "disabled", "skipped 사유는 'disabled'여야 한다");
  assert(!fetchCalled, "enabled=false면 fetchCandidates를 호출하면 안 된다");
  console.log("✅ enabled=false -> 크롤링 없이 skipped");

  // 2) dryRun이면 크롤링/매핑까지 하고 DB 쓰기는 건너뛴다.
  const candidates = [
    makeCandidate("드라마", "폭싹 속았수다", 1),
    makeCandidate("드라마", "중증외상센터", 2),
  ];
  const dry = await runCreatorAdvisorCollection({
    enabled: true,
    dryRun: true,
    fetchCandidates: async () => makeFetchResult(candidates),
  });
  assert(dry.status === "success", `dryRun 성공해야 한다 (실제: ${dry.status} ${dry.error ?? ""})`);
  assert(dry.fetchedCount === 2, `조회 건수는 2여야 한다 (실제: ${dry.fetchedCount})`);
  assert(dry.upsertedCount === 0, "dryRun에서는 저장 건수가 0이어야 한다");
  assert(dry.expiredCount === 0, "dryRun에서는 만료 건수가 0이어야 한다");
  assert(dry.trendDate === TREND_DATE, `trendDate가 보존되어야 한다 (실제: ${dry.trendDate})`);
  console.log(`✅ dryRun -> ${dry.fetchedCount}건 조회, DB 쓰기 0건, trendDate=${dry.trendDate}`);

  // 3) 크롤링 실패(로그인 만료 등)가 예외로 새어나가지 않고 status='failed'로 격리되어야 한다.
  //    daily workflow가 이 실패에도 seed_queries만으로 계속 진행할 수 있어야 하기 때문이다.
  const failed = await runCreatorAdvisorCollection({
    enabled: true,
    dryRun: true,
    fetchCandidates: async () => {
      throw new Error("로그인이 필요합니다");
    },
  });
  assert(failed.status === "failed", "크롤링 실패 시 status='failed'여야 한다");
  assert(failed.error?.includes("로그인"), `실패 사유가 보존되어야 한다 (실제: ${failed.error})`);
  assert(failed.fetchedCount === 0 && failed.upsertedCount === 0, "실패 시 건수는 모두 0이어야 한다");
  console.log(`✅ 크롤링 실패 -> 예외 없이 status='failed' 격리 (사유: ${failed.error})`);

  // 4) topic 단위 부분 실패는 전체 실패가 아니라 topicErrors로 전달되어야 한다.
  const partial = await runCreatorAdvisorCollection({
    enabled: true,
    dryRun: true,
    fetchCandidates: async () => ({
      ...makeFetchResult(candidates),
      topicErrors: { "card[3]": "selector 불일치" },
    }),
  });
  assert(partial.status === "success", "topic 부분 실패는 전체 성공을 막지 않아야 한다");
  assert(partial.topicErrors["card[3]"] === "selector 불일치", "topicErrors가 그대로 전달되어야 한다");
  console.log("✅ topic 부분 실패 -> success 유지 + topicErrors 전달");

  // 5) 같은 키워드가 같은 내부 카테고리의 서로 다른 topic에 등장하면 unique index conflict key가
  //    배치 안에서 겹쳐 upsert 전체가 21000으로 거부된다. 그래서 DB에 보내기 전에 병합되어야 한다.
  //    실제 매핑상 "드라마"와 "영화"는 둘 다 ott로 축소된다.
  const dupA = makeCandidate("드라마", "오디세이", 1);
  const dupB = makeCandidate("영화", "오디세이", 5);
  const inserts = mapCreatorAdvisorCandidatesToInserts([dupA, dupB]);
  assert(
    inserts[0].topic_normalized === inserts[1].topic_normalized,
    `드라마/영화는 같은 카테고리로 매핑되어야 한다 (실제: ${inserts[0].topic_normalized}, ${inserts[1].topic_normalized})`
  );

  const deduped = dedupeTrendCandidateInserts(inserts);
  assert(deduped.rows.length === 1, `중복이 1건으로 병합되어야 한다 (실제: ${deduped.rows.length}건)`);
  assert(deduped.droppedCount === 1, `병합으로 사라진 건수는 1이어야 한다 (실제: ${deduped.droppedCount})`);
  assert(deduped.rows[0].rank === 1, `더 높은 pre-score(rank 1)가 살아남아야 한다 (실제: rank ${deduped.rows[0].rank})`);
  assert(
    Array.isArray(deduped.rows[0].metadata?.mergedFrom) &&
      (deduped.rows[0].metadata.mergedFrom as unknown[]).length === 1,
    "버려진 쪽의 topic이 metadata.mergedFrom에 보존되어야 한다"
  );
  assert(deduped.rows[0].topic === "드라마", `원본 topic은 승자의 것이어야 한다 (실제: ${deduped.rows[0].topic})`);
  console.log(
    `✅ 같은 카테고리 내 중복 -> 1건으로 병합 (승자 topic=${deduped.rows[0].topic}, ` +
      `mergedFrom 보존)`
  );

  // 6) 서로 다른 카테고리면 conflict key가 다르므로 병합하지 않는다.
  //    주의: category는 이제 키워드 어휘로 먼저 판정한다(keywordCategoryRules.ts). 그래서 분류 신호가
  //    있는 키워드는 어느 topic에 있든 같은 category가 되어 오히려 병합되는 것이 정상이다.
  //    이 케이스는 "분류 신호가 없어 topic 매핑으로 폴백하는" 키워드여야 성립한다 -
  //    "민음사 빵"은 어떤 규칙에도 걸리지 않으므로 드라마->ott, 일상·생각->living으로 갈린다.
  const crossCategory = dedupeTrendCandidateInserts(
    mapCreatorAdvisorCandidatesToInserts([
      makeCandidate("드라마", "민음사 빵", 1),
      makeCandidate("일상·생각", "민음사 빵", 2),
    ])
  );
  assert(
    crossCategory.rows[0].topic_normalized !== crossCategory.rows[1]?.topic_normalized,
    "이 케이스는 두 행의 category가 실제로 달라야 성립한다"
  );
  assert(crossCategory.rows.length === 2, `다른 카테고리는 병합하지 않아야 한다 (실제: ${crossCategory.rows.length}건)`);
  assert(crossCategory.droppedCount === 0, "다른 카테고리는 droppedCount가 0이어야 한다");
  console.log("✅ 다른 카테고리 중복 -> 병합하지 않고 2건 유지");

  // 7) 반대로, 분류 신호가 있는 키워드는 topic이 달라도 같은 category로 모여 병합되어야 한다.
  //    (같은 키워드가 카드마다 다른 category로 흩어지던 문제를 막는 것이 분류기의 목적이다.)
  const sameKeywordAcrossTopics = dedupeTrendCandidateInserts(
    mapCreatorAdvisorCandidatesToInserts([
      makeCandidate("드라마", "양준모 재혼 상대 양지원", 1),
      makeCandidate("육아·결혼", "양준모 재혼 상대 양지원", 2),
    ])
  );
  assert(
    sameKeywordAcrossTopics.rows.length === 1,
    `분류 신호가 있으면 topic이 달라도 1건으로 모여야 한다 (실제: ${sameKeywordAcrossTopics.rows.length}건)`
  );
  assert(
    sameKeywordAcrossTopics.rows[0].topic_normalized === "entertainment",
    `"재혼"은 topic과 무관하게 entertainment여야 한다 (실제: ${sameKeywordAcrossTopics.rows[0].topic_normalized})`
  );
  console.log("✅ 분류 신호 있는 키워드 -> topic 달라도 같은 category로 병합");

  console.log("\n✅ Creator Advisor Collection 배선 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
