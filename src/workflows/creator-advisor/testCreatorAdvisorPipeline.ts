// Creator Advisor -> trend_candidates 저장 파이프라인(mapper/score/selection) 테스트.
// 실제 Supabase를 호출하지 않는다 - 순수 함수만 검증한다(요구사항: 이번 단계에서 실제 insert 금지).
// SeedQueryRepository 테스트와 동일하게, 별도 테스트 프레임워크 없이 assert 헬퍼 + 콘솔 로그로 검증한다.

import { CREATOR_ADVISOR_TOPIC_CATEGORY_MAP } from "../../config/creatorAdvisorTopicMapping.js";
import { mapCreatorAdvisorCandidateToInsert, mapCreatorAdvisorCandidatesToInserts } from "./mapCreatorAdvisorCandidates.js";
import { computeCreatorAdvisorCandidateScore } from "./scoreCreatorAdvisorCandidate.js";
import { selectTopCreatorAdvisorCandidates } from "./selectTopCreatorAdvisorCandidates.js";
import type { CreatorAdvisorMovementType, CreatorAdvisorTrendCandidate } from "../../services/search/providers/CreatorAdvisorProvider.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const TREND_DATE = "2026-08-24";
const COLLECTED_AT = "2026-08-25T16:00:00.000Z";

function makeCandidate(
  topic: string,
  keyword: string,
  rank: number,
  movementType: CreatorAdvisorMovementType,
  rankChange: number | null
): CreatorAdvisorTrendCandidate {
  return {
    keyword,
    topic,
    rank,
    movementType,
    previousRank: rankChange !== null ? rank + rankChange : null,
    rankChange,
    collectedAt: COLLECTED_AT,
    metadata: { trendDate: TREND_DATE, rawMovementClass: null, rawMovementText: null },
  };
}

// 실측 확인된 11개 topic. 첫 10개 topic은 11개, 마지막 topic은 10개씩 만들어 정확히 120개로 한다(요구사항 D/E:
// "120개 후보 -> max40 selection", "topic diversity").
const TOPICS = Object.keys(CREATOR_ADVISOR_TOPIC_CATEGORY_MAP);
const MOVEMENTS: CreatorAdvisorMovementType[] = ["new", "up", "down", "flat"];

function buildFixtureCandidates(): CreatorAdvisorTrendCandidate[] {
  const candidates: CreatorAdvisorTrendCandidate[] = [];
  for (const [topicIndex, topic] of TOPICS.entries()) {
    const candidateCount = topicIndex === TOPICS.length - 1 ? 10 : 11;
    for (let i = 0; i < candidateCount; i++) {
      const rank = i + 1;
      const movementType = MOVEMENTS[i % MOVEMENTS.length];
      const rankChange = movementType === "up" ? (i + 1) * 7 : movementType === "down" ? -(i + 1) : movementType === "flat" ? 0 : null;
      candidates.push(makeCandidate(topic, `${topic} 키워드${rank}`, rank, movementType, rankChange));
    }
  }
  return candidates;
}

function main() {
  console.log("▶ Creator Advisor 파이프라인(mapper/score/selection) 테스트 시작");

  // ---------- A. parser 결과 -> mapper -> trend_candidates insert shape ----------
  const sample = makeCandidate("스타·연예인", "우서윤", 1, "flat", 0);
  const insertRow = mapCreatorAdvisorCandidateToInsert(sample);

  assert(insertRow.keyword === "우서윤", "keyword가 그대로 보존되어야 합니다");
  assert(insertRow.keyword_normalized === "우서윤", `keyword_normalized가 정규화되어야 합니다 (실제: ${insertRow.keyword_normalized})`);
  assert(insertRow.topic === "스타·연예인", "원본 topic이 그대로 보존되어야 합니다(요구사항)");
  assert(insertRow.topic_normalized === "entertainment", `topic_normalized는 내부 category mapping 결과여야 합니다 (실제: ${insertRow.topic_normalized})`);
  assert(insertRow.source === "creator_advisor", "source는 creator_advisor여야 합니다");
  assert(insertRow.trend_date === TREND_DATE, `trend_date는 candidate.metadata.trendDate를 써야 합니다 (실제: ${insertRow.trend_date})`);
  assert(insertRow.rank === 1, "rank가 그대로 보존되어야 합니다");
  assert(insertRow.movement_type === "flat", "movement_type이 그대로 보존되어야 합니다");
  assert(insertRow.rank_change === 0, "rank_change가 그대로 보존되어야 합니다");
  assert(typeof insertRow.candidate_score === "number", "candidate_score가 계산되어 채워져야 합니다");
  assert(!("previous_rank" in insertRow), "제거된 previous_rank 컬럼을 insert shape에 다시 포함하면 안 됩니다");
  assert(!("collected_date" in insertRow), "제거된 collected_date 컬럼을 insert shape에 다시 포함하면 안 됩니다");
  assert(insertRow.status === "active", "status 기본값은 active여야 합니다");
  assert(typeof insertRow.expires_at === "string", "expires_at이 candidateTtlHours 기준으로 계산되어야 합니다");
  console.log("✅ A. parser 결과 -> mapper -> insert shape 검증 완료:", insertRow);

  // topic_normalized 매핑 표 전체(육아·결혼/드라마/영화 등)도 원본 보존 + mapping을 함께 확인.
  const dramaRow = mapCreatorAdvisorCandidateToInsert(makeCandidate("드라마", "폭싹속았수다", 1, "up", 2));
  assert(dramaRow.topic === "드라마" && dramaRow.topic_normalized === "ott", `"드라마"는 topic 보존 + topic_normalized="ott"여야 합니다 (실제: topic=${dramaRow.topic}, topic_normalized=${dramaRow.topic_normalized})`);
  const parentingRow = mapCreatorAdvisorCandidateToInsert(makeCandidate("육아·결혼", "출산가방", 1, "new", null));
  assert(parentingRow.topic_normalized === "parenting", `"육아·결혼"은 topic_normalized="parenting"이어야 합니다 (실제: ${parentingRow.topic_normalized})`);
  console.log("✅ topic 원본 보존 + category mapping(드라마->ott, 육아·결혼->parenting) 검증 완료");

  // ---------- B. upsert duplicate -> 중복 row 생성 안 됨(실제 DB 없이 conflict key로 시뮬레이션) ----------
  // 같은 keyword+topic+trendDate를 다른 시각에 재수집한 상황(rank/movementType만 달라짐)을 흉내낸다.
  const firstCollection = makeCandidate("방송", "박위 다친 이유", 5, "new", null);
  const secondCollection = makeCandidate("방송", "박위 다친 이유", 2, "up", 18);
  const [firstRow, secondRow] = mapCreatorAdvisorCandidatesToInserts([firstCollection, secondCollection]);

  function conflictKey(row: { keyword_normalized: string; topic_normalized: string; trend_date: string; source?: string }): string {
    return [row.keyword_normalized, row.topic_normalized, row.trend_date, row.source ?? "creator_advisor"].join("::");
  }

  assert(
    conflictKey(firstRow) === conflictKey(secondRow),
    "같은 keyword+topic+trendDate로 재수집한 두 row는 동일한 conflict key를 가져야 upsert가 한 row로 병합합니다"
  );

  // upsert가 실제로 하는 일(같은 conflict key는 마지막 값으로 덮어씀)을 Map으로 시뮬레이션.
  const upserted = new Map<string, typeof firstRow>();
  for (const row of [firstRow, secondRow]) {
    upserted.set(conflictKey(row), row);
  }
  assert(upserted.size === 1, `동일 conflict key 2건은 upsert 후 1 row만 남아야 합니다 (실제: ${upserted.size})`);
  assert(upserted.get(conflictKey(secondRow))!.rank === 2, "마지막 upsert 값(재수집 결과)이 최종 값이어야 합니다");
  console.log("✅ B. upsert duplicate 시뮬레이션 -> conflict key 동일 + 최신 값으로 병합 검증 완료 (실제 DB 미사용)");

  // ---------- C. candidate scoring: new/up/down/flat ----------
  const newScore = computeCreatorAdvisorCandidateScore({ rank: 1, movementType: "new", rankChange: null });
  assert(newScore === 35, `rank=1(+20) + new(+15) = 35여야 합니다 (실제: ${newScore})`);

  const upBigScore = computeCreatorAdvisorCandidateScore({ rank: 4, movementType: "up", rankChange: 60 });
  assert(upBigScore === 30, `rank=4(+15) + up(+5) + rankChange>=50(+10) = 30이어야 합니다 (실제: ${upBigScore})`);

  const upSmallScore = computeCreatorAdvisorCandidateScore({ rank: 8, movementType: "up", rankChange: 6 });
  assert(upSmallScore === 18, `rank=8(+10) + up(+5) + rankChange>=5(+3) = 18이어야 합니다 (실제: ${upSmallScore})`);

  const downScore = computeCreatorAdvisorCandidateScore({ rank: 15, movementType: "down", rankChange: -3 });
  assert(downScore === 5, `rank=15(+5) + down(+0) = 5여야 합니다 (실제: ${downScore})`);

  const flatScore = computeCreatorAdvisorCandidateScore({ rank: 25, movementType: "flat", rankChange: 0 });
  assert(flatScore === 7, `rank=25(fallback +2) + flat(+5) = 7이어야 합니다 (실제: ${flatScore})`);

  console.log("✅ C. candidate scoring(new/up/down/flat) 검증 완료:", { newScore, upBigScore, upSmallScore, downScore, flatScore });

  // ---------- D/E. 120개 후보 -> max 40 selection + topic diversity ----------
  const fixtureCandidates = buildFixtureCandidates();
  assert(fixtureCandidates.length === 120, `fixture는 정확히 120개여야 합니다 (실제: ${fixtureCandidates.length})`);

  const scored = fixtureCandidates.map((c) => ({ ...c, candidateScore: computeCreatorAdvisorCandidateScore(c) }));
  const selected = selectTopCreatorAdvisorCandidates(scored, { maxTotal: 40, maxPerTopic: 6 });

  assert(selected.length === 40, `120개 입력 중 maxTotal=40이 선택되어야 합니다 (실제: ${selected.length})`);

  const countByTopic = new Map<string, number>();
  for (const item of selected) {
    countByTopic.set(item.topic, (countByTopic.get(item.topic) ?? 0) + 1);
  }
  assert(
    [...countByTopic.values()].every((count) => count <= 6),
    `topic당 최대 6개(maxPerTopic)를 넘으면 안 됩니다 (실제: ${JSON.stringify([...countByTopic.entries()])})`
  );
  assert(
    countByTopic.size === TOPICS.length,
    `topic ${TOPICS.length}개 모두에서 최소 1개씩은 선택되어야 diversity가 보장됩니다 (실제로 포함된 topic 수: ${countByTopic.size})`
  );
  console.log(`✅ D. 120개 입력 -> max 40 selection 검증 완료 (선택: ${selected.length}개)`);
  console.log("✅ E. topic별 선택 분포(diversity) 검증 완료:", Object.fromEntries(countByTopic));

  console.log("\n✅ Creator Advisor 파이프라인 테스트 완료");
}

main();
