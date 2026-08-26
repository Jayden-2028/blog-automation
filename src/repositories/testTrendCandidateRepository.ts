// TrendCandidateRepository의 실제 Supabase 프로젝트 대상 integration smoke test.
// SeedQueryRepository와 마찬가지로 이 스크립트가 직접 만든 row만 id 기준으로 추적/삭제한다 -
// 운영 데이터(source='creator_advisor' 등)는 절대 건드리지 않는다.
//
// 실수로 CI/기본 실행 흐름에서 실 DB에 쓰기가 발생하지 않도록, ALLOW_SUPABASE_WRITE_TEST=1이
// 정확히 설정된 경우에만 동작한다. 그 외에는 supabase client/repository를 아예 import하지 않고
// (동적 import 이전에) 즉시 중단한다.
//
// 사용법: ALLOW_SUPABASE_WRITE_TEST=1 npm run test:trend-candidate-repository

import type { TrendCandidateInsert } from "../types/database.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`❌ 검증 실패: ${message}`);
  }
}

async function main() {
  const { TrendCandidateRepository } = await import("./TrendCandidateRepository.js");

  console.log("▶ TrendCandidateRepository integration smoke test 시작");

  const suffix = Date.now();
  // 운영 source(creator_advisor)와 절대 겹치지 않도록 별도 test source 두 개를 쓴다.
  // testSource는 실제로 검증 대상, otherSource는 "source로 격리되는지"를 증명하기 위한 대조군이다.
  const testSource = `test_smoke_${suffix}`;
  const otherSource = `test_smoke_other_${suffix}`;
  const trendDate = new Date().toISOString().slice(0, 10);

  const keyword = `테스트 트렌드 후보 ${suffix}`;
  const topic = `테스트 토픽 ${suffix}`;
  const keywordNormalized = normalize(keyword);
  const topicNormalized = normalize(topic);

  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 60 * 1000).toISOString();

  // 이 테스트가 직접 생성한 row의 id만 모아둔다 — cleanup은 이 목록에 있는 id만 삭제한다.
  const createdIds: string[] = [];

  const baseCandidate: Omit<TrendCandidateInsert, "source" | "rank" | "candidate_score" | "expires_at"> = {
    keyword,
    keyword_normalized: keywordNormalized,
    topic,
    topic_normalized: topicNormalized,
    trend_date: trendDate,
    movement_type: "new",
  };

  try {
    // 1. upsert 최초 삽입 (testSource) - rank 1, 만료 미래.
    const insertedC1 = await TrendCandidateRepository.upsertCandidates([
      { ...baseCandidate, source: testSource, rank: 1, candidate_score: 10, expires_at: futureIso },
    ]);
    assert(insertedC1.length === 1, "C1 최초 upsert가 정확히 1개 row를 반환해야 합니다.");
    const c1Id = insertedC1[0]!.id;
    createdIds.push(c1Id);
    console.log("✅ C1 최초 삽입:", c1Id);

    // 2. 같은 (keyword_normalized, topic_normalized, trend_date, source) 조합으로 재upsert하면
    //    같은 row가 갱신되어야 한다 (새 row가 생기면 안 됨).
    const updatedC1 = await TrendCandidateRepository.upsertCandidates([
      { ...baseCandidate, source: testSource, rank: 2, candidate_score: 20, expires_at: futureIso },
    ]);
    assert(updatedC1.length === 1, "C1 재upsert가 정확히 1개 row를 반환해야 합니다.");
    assert(updatedC1[0]!.id === c1Id, "C1 재upsert가 같은 id를 유지해야 합니다 (dedupe).");
    assert(updatedC1[0]!.rank === 2, "C1 재upsert 후 rank가 갱신되어야 합니다.");
    console.log("✅ C1 재upsert가 같은 row를 갱신함 (dedupe 검증 완료)");

    // 3. otherSource로 C2 삽입 - source 격리 검증용 대조군.
    const insertedC2 = await TrendCandidateRepository.upsertCandidates([
      { ...baseCandidate, source: otherSource, rank: 1, candidate_score: 15, expires_at: futureIso },
    ]);
    assert(insertedC2.length === 1, "C2 삽입이 정확히 1개 row를 반환해야 합니다.");
    const c2Id = insertedC2[0]!.id;
    createdIds.push(c2Id);
    console.log("✅ C2(otherSource) 삽입:", c2Id);

    // 4. listCandidatesByTrendDate: source별로 정확히 격리되어야 한다.
    const listTest = await TrendCandidateRepository.listCandidatesByTrendDate(trendDate, { source: testSource });
    assert(
      listTest.length === 1 && listTest[0]!.id === c1Id && listTest[0]!.rank === 2,
      "listCandidatesByTrendDate(testSource)가 C1만, 갱신된 rank로 반환해야 합니다."
    );
    const listOther = await TrendCandidateRepository.listCandidatesByTrendDate(trendDate, { source: otherSource });
    assert(
      listOther.length === 1 && listOther[0]!.id === c2Id,
      "listCandidatesByTrendDate(otherSource)가 C2만 반환해야 합니다."
    );
    console.log("✅ listCandidatesByTrendDate source 격리 검증 완료");

    // 5. getLatestAvailableTrendDate / listLatestActiveCandidates.
    const latestDate = await TrendCandidateRepository.getLatestAvailableTrendDate(testSource);
    assert(latestDate === trendDate, "getLatestAvailableTrendDate(testSource)가 trendDate를 반환해야 합니다.");

    const latest = await TrendCandidateRepository.listLatestActiveCandidates(testSource);
    assert(
      latest.trendDate === trendDate &&
        latest.candidates.length === 1 &&
        latest.candidates[0]!.id === c1Id,
      "listLatestActiveCandidates(testSource)가 C1만 포함한 결과를 반환해야 합니다."
    );
    console.log("✅ getLatestAvailableTrendDate / listLatestActiveCandidates 검증 완료");

    // 6. C1, C2 둘 다 만료 대상(expires_at 과거)으로 갱신한 뒤, source를 넘긴
    //    expireOldCandidates가 testSource(C1)만 만료시키고 otherSource(C2)는 건드리지 않아야 한다.
    const expiredC1 = await TrendCandidateRepository.upsertCandidates([
      { ...baseCandidate, source: testSource, rank: 2, candidate_score: 20, expires_at: pastIso },
    ]);
    assert(expiredC1[0]!.id === c1Id, "C1 만료용 upsert도 같은 id를 유지해야 합니다.");

    const expiredC2 = await TrendCandidateRepository.upsertCandidates([
      { ...baseCandidate, source: otherSource, rank: 1, candidate_score: 15, expires_at: pastIso },
    ]);
    assert(expiredC2[0]!.id === c2Id, "C2 만료용 upsert도 같은 id를 유지해야 합니다.");

    const expiredCount = await TrendCandidateRepository.expireOldCandidates({ source: testSource });
    assert(expiredCount === 1, `expireOldCandidates({ source: testSource })는 1건만 만료시켜야 합니다 (실제 ${expiredCount}건).`);
    console.log("✅ expireOldCandidates가 testSource row만 만료시킴 (count =", expiredCount, ")");

    const afterExpireTest = await TrendCandidateRepository.listCandidatesByTrendDate(trendDate, {
      source: testSource,
    });
    assert(afterExpireTest.length === 0, "만료 후 status='active' 기본 조회에서 C1이 빠져야 합니다.");

    const afterExpireTestExplicit = await TrendCandidateRepository.listCandidatesByTrendDate(trendDate, {
      source: testSource,
      status: "expired",
    });
    assert(
      afterExpireTestExplicit.length === 1 && afterExpireTestExplicit[0]!.id === c1Id,
      "C1은 status='expired'로 조회했을 때 나와야 합니다."
    );

    // otherSource(C2)는 여전히 active여야 한다 (source 필터가 실제로 격리했는지 최종 확인).
    const afterExpireOther = await TrendCandidateRepository.listCandidatesByTrendDate(trendDate, {
      source: otherSource,
    });
    assert(
      afterExpireOther.length === 1 && afterExpireOther[0]!.id === c2Id,
      "expireOldCandidates({ source: testSource })가 otherSource(C2)를 건드리면 안 됩니다."
    );
    console.log("✅ source-filtered expiration이 다른 source row에 영향을 주지 않음을 확인");

    console.log("\n✅ TrendCandidateRepository integration smoke test 완료");
  } finally {
    // cleanup: 이 테스트가 만든 id만 삭제. 운영 데이터에는 영향 없음.
    // cleanup 실패(예외) 또는 삭제 개수 불일치는 경고로 넘기지 않고 테스트 전체를 실패시킨다 -
    // 그대로 두면 다음 실행에서 stale 테스트 row가 계속 쌓이거나, 삭제 실패를 놓칠 수 있다.
    const uniqueCreatedIds = [...new Set(createdIds)];
    if (uniqueCreatedIds.length > 0) {
      const deletedCount = await TrendCandidateRepository.deleteCandidatesByIds(uniqueCreatedIds);
      if (deletedCount !== uniqueCreatedIds.length) {
        throw new Error(
          `cleanup 삭제 개수(${deletedCount})가 생성한 고유 id 개수(${uniqueCreatedIds.length})와 다릅니다.`
        );
      }
      console.log(`🧹 테스트 candidate ${deletedCount}/${uniqueCreatedIds.length}건 정리 완료`);
    }
  }
}

if (process.env.ALLOW_SUPABASE_WRITE_TEST !== "1") {
  console.error(
    "❌ 이 스크립트는 실제 Supabase 프로젝트에 쓰기를 수행합니다. " +
      "ALLOW_SUPABASE_WRITE_TEST=1 환경변수를 정확히 설정한 경우에만 실행됩니다.\n" +
      "   예: ALLOW_SUPABASE_WRITE_TEST=1 npm run test:trend-candidate-repository"
  );
  process.exit(1);
}

main().catch((error) => {
  console.error("❌ TrendCandidateRepository 테스트 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
