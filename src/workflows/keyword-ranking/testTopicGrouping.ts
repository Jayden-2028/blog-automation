// topicGrouping + selectDiverseTopN 회귀 테스트.
//
// 고정하는 불변식(2026-08-29 실측 재현):
//   "넷플릭스 들쥐" 한 이슈가 서로 다른 canonical keyword 4개로 Top 10에 4칸을 차지했다.
//   clustering 단계에서는 병합되지 않는다(cross-seed seed-token 제거로 교집합이 정확히 0). 그래서
//   최종 선정 단계에서 잡아야 하고, 이 테스트가 그 지점을 고정한다.
//
// 함께 고정하는 반대 방향 불변식(과병합 방지):
//   - 같은 플랫폼("넷플릭스")이라는 이유만으로 서로 다른 작품이 묶이면 안 된다.
//   - "리뷰/후기/촬영지" 같은 범용 수식어 하나로 서로 다른 이슈가 묶이면 안 된다.
//   - 도배가 사라진 자리에는 실제로 다른 주제가 들어와야 한다(사용자가 원한 "추가 룸").
//
// 외부 호출/DB 접근 없이 순수 함수만 검증한다.

import { DIVERSITY_CONFIG } from "../../config/keywordScoring.js";
import { buildTopicIndex } from "./topicGrouping.js";
import { selectDiverseTopN, type DiversityCandidate } from "./selectDiverseTopN.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

type Candidate = DiversityCandidate & { headline: string };

function makeCandidate(
  headline: string,
  seedQuery: string | null,
  category: string,
  totalScore: number
): Candidate {
  return { keyword: headline, headline, seedQuery, category, totalScore };
}

// 실제 run의 batch 규모(수백 개 cluster)를 흉내 낸다. df 기반 희소성 판정은 batch 크기에 의존하므로
// 소수 후보만으로 테스트하면 실제 동작과 다른 결과가 나온다.
function makeFillerCandidates(count: number): Candidate[] {
  const fillers: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    // 서로 다른 주제가 되도록 고유 토큰을 넣는다.
    fillers.push(
      makeCandidate(`지역${i} 소식 사안${i} 관련 안내문 발표`, `기타${i % 17}`, "living", 30 - i * 0.01)
    );
  }
  return fillers;
}

// "넷플릭스 들쥐" 한 이슈가 seed 2개("넷플릭스" = seed_queries, "들쥐" = Creator Advisor)에서
// 서로 다른 제목으로 잡힌 실제 상황.
const DEULJWI = [
  makeCandidate("넷플릭스 새 시리즈 들쥐 공개일 확정", "넷플릭스", "ott", 72),
  makeCandidate("넷플릭스 들쥐 출연진 총정리", "넷플릭스", "ott", 71),
  makeCandidate("들쥐 1화 리뷰 몰아보기 후기", "들쥐", "ott", 70),
  makeCandidate("들쥐 결말 해석과 시즌2 가능성", "들쥐", "ott", 69),
];

// 같은 플랫폼이지만 완전히 다른 작품 - 묶이면 안 된다.
const OTHER_NETFLIX = makeCandidate("넷플릭스 오징어게임 스핀오프 제작 발표", "넷플릭스", "ott", 68);

// 도배가 사라진 자리에 들어와야 하는 다른 주제들.
const OTHERS = [
  makeCandidate("부모급여 인상분 지급 시기 안내", "부모급여", "parenting", 62),
  makeCandidate("전국 폭염특보 확대 발효", "날씨", "living", 61),
  makeCandidate("장동윤 결혼 발표 예비신부 화제", "연예", "entertainment", 60),
  makeCandidate("근로장려금 반기신청 지급일 조회", "근로장려금", "living", 59),
  makeCandidate("추석 연휴 고속도로 통행료 면제", "추석", "living", 58),
  makeCandidate("독감 예방접종 무료 대상 확대", "예방접종", "parenting", 57),
  // 범용 수식어("리뷰")만 공유하는 서로 다른 작품 - 묶이면 안 된다.
  makeCandidate("영화 파묘 재개봉 리뷰 반응", "영화", "ott", 56),
  // community(2026-08-29 추가) 대표. 점수가 낮아 greedy 단계에서는 못 들어오고 backfill로만 들어온다.
  makeCandidate("출근길 빌런 목격담 갑론을박", "커뮤니티", "community", 40),
];

function main(): void {
  console.log("▶ topicGrouping / selectDiverseTopN 회귀 테스트 시작\n");

  assert(
    DIVERSITY_CONFIG.enableTopicGrouping,
    "DIVERSITY_CONFIG.enableTopicGrouping이 false다 - 이 테스트는 주제 그룹핑이 켜져 있어야 의미가 있다"
  );

  const batch = [...DEULJWI, OTHER_NETFLIX, ...OTHERS, ...makeFillerCandidates(380)].sort(
    (a, b) => b.totalScore - a.totalScore
  );

  // ---------- 1. isSameTopic 판정 ----------
  const index = buildTopicIndex(batch, (item) => item.headline);
  console.log(`  batch ${batch.length}건, 희소 판정 df 상한 = ${index.distinctiveThreshold}`);

  for (let i = 0; i < DEULJWI.length; i++) {
    for (let j = i + 1; j < DEULJWI.length; j++) {
      assert(
        index.isSameTopic(DEULJWI[i], DEULJWI[j]),
        `같은 이슈로 판정돼야 한다: "${DEULJWI[i].headline}" vs "${DEULJWI[j].headline}"`
      );
    }
  }
  console.log("  ✅ 넷플릭스 들쥐 4건이 서로 같은 주제로 판정됨 (cross-seed 포함)");

  for (const item of DEULJWI) {
    assert(
      !index.isSameTopic(item, OTHER_NETFLIX),
      `플랫폼 이름만 공유하는 다른 작품은 묶이면 안 된다: "${item.headline}" vs "${OTHER_NETFLIX.headline}"`
    );
  }
  console.log("  ✅ 같은 '넷플릭스'라도 다른 작품(오징어게임)은 별개 주제로 유지됨");

  const reviewMovie = OTHERS[OTHERS.length - 1];
  assert(
    !index.isSameTopic(DEULJWI[2], reviewMovie),
    `범용 수식어("리뷰")만 공유하는 항목이 묶이면 안 된다: "${DEULJWI[2].headline}" vs "${reviewMovie.headline}"`
  );
  console.log("  ✅ '리뷰/후기' 같은 범용 수식어만으로는 묶이지 않음");

  const distinctive = index.distinctiveTokensOf(DEULJWI[0]);
  assert(distinctive.has("들쥐"), "'들쥐'가 희소 토큰으로 인식돼야 한다");
  assert(
    !distinctive.has("넷플릭스"),
    "'넷플릭스'는 분류어(categoryTerms)이므로 주제 토큰에서 빠져야 한다"
  );
  console.log("  ✅ 토큰 판정: 들쥐=주제 토큰(희소), 넷플릭스=분류어로 제외");

  // seed_queries 유래 상시 검색어를 runtime으로 주입하는 경로도 함께 고정한다.
  // "부모급여"는 고정 목록에 없지만 seed_queries에 등록돼 있으므로 분류어로 취급돼야 한다.
  const parentingBatch = [
    makeCandidate("부모급여 인상분 지급 시기 안내", "부모급여", "parenting", 62),
    makeCandidate("부모급여 신청 서류 준비물 확인", "부모급여", "parenting", 61),
    ...makeFillerCandidates(120),
  ].sort((a, b) => b.totalScore - a.totalScore);

  const withoutSeedTerms = buildTopicIndex(parentingBatch, (item) => item.headline);
  assert(
    withoutSeedTerms.isSameTopic(parentingBatch.find((c) => c.headline.includes("인상분"))!, parentingBatch.find((c) => c.headline.includes("서류"))!),
    "분류어 주입이 없으면 '부모급여'만 공유해도 같은 주제로 묶인다(기준선 확인)"
  );

  const withSeedTerms = buildTopicIndex(parentingBatch, (item) => item.headline, {
    extraCategoryTerms: ["부모급여", "육아", "넷플릭스"],
  });
  assert(
    !withSeedTerms.isSameTopic(parentingBatch.find((c) => c.headline.includes("인상분"))!, parentingBatch.find((c) => c.headline.includes("서류"))!),
    "seed_queries 유래 분류어를 주입하면 '부모급여'만으로는 묶이지 않아야 한다"
  );
  console.log("  ✅ seed_queries 유래 분류어 runtime 주입이 실제로 판정을 바꿈");

  // ---------- 2. selectDiverseTopN 결과 ----------
  const top = selectDiverseTopN(batch, 10);
  console.log("\n  최종 Top 10:");
  top.forEach((item, i) => console.log(`    ${i + 1}. [${item.category}] ${item.headline} (${item.totalScore})`));

  const deuljwiInTop = top.filter((item) => DEULJWI.some((d) => d.headline === item.headline));
  assert(
    deuljwiInTop.length === DIVERSITY_CONFIG.maxPerCanonicalTopic,
    `넷플릭스 들쥐는 Top 10에 ${DIVERSITY_CONFIG.maxPerCanonicalTopic}건만 있어야 한다 (실제 ${deuljwiInTop.length}건)`
  );
  console.log(`\n  ✅ 넷플릭스 들쥐 4건 -> ${deuljwiInTop.length}건으로 축소`);

  assert(top.length === 10, `Top 10이 10건으로 채워져야 한다 (실제 ${top.length}건)`);

  // 도배가 사라진 자리는 다른 주제로 채워져야 한다 - 빈칸으로 남거나 같은 주제가 다시 들어오면 안 된다.
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      assert(
        !index.isSameTopic(top[i], top[j]),
        `Top 10 안에 같은 주제가 두 번 들어왔다: "${top[i].headline}" vs "${top[j].headline}"`
      );
    }
  }
  console.log("  ✅ Top 10 안에 같은 주제 중복 없음");

  assert(
    top.some((item) => item.headline === OTHER_NETFLIX.headline),
    "다른 넷플릭스 작품은 여전히 Top 10에 남아야 한다(과병합 방지)"
  );
  console.log("  ✅ 확보된 자리에 다른 주제가 실제로 채워짐");

  // backfill은 "pool에 후보가 있는" target category만 채운다(없는 category를 억지로 만들지 않는 것이
  // selectDiverseTopN의 3번 규칙이다). 그래서 pool에 실제로 존재하는 category만 검사한다.
  const categories = new Set(top.map((item) => item.category));
  const categoriesInPool = new Set(batch.map((item) => item.category));
  for (const category of DIVERSITY_CONFIG.targetCategories) {
    if (!categoriesInPool.has(category)) continue;
    assert(categories.has(category), `category backfill이 깨졌다 - "${category}" 대표가 없다`);
  }
  console.log(
    `  ✅ pool에 존재하는 target category 전부 대표 확보 (${DIVERSITY_CONFIG.targetCategories.filter((c) => categoriesInPool.has(c)).join(", ")})`
  );

  // community는 점수가 낮아 greedy로는 못 들어온다 - backfill이 실제로 동작했다는 뜻이다.
  assert(
    top.some((item) => item.category === "community"),
    "신규 community category가 backfill로 Top 10에 들어와야 한다"
  );
  console.log("  ✅ community(신규 category)가 backfill로 편입됨");

  // ---------- 3. maxPerSeedQuery: 구체 seedQuery는 1건, 분류어 seedQuery는 제한 없음 ----------
  // 실측(run #20/#22/#23): "황재균 지연", "상생페이백 사용" 같은 구체 seedQuery에서 같은 사건
  // 기사 2건이 Top 1·2를 차지했다. maxPerSeedQuery=1로 이걸 막되, "넷플릭스"처럼 분류어인
  // seedQuery는 서로 다른 작품을 담을 수 있어야 하므로 제외한다.
  assert(DIVERSITY_CONFIG.maxPerSeedQuery === 1, "이 회귀 테스트는 maxPerSeedQuery=1 전제다");
  {
    const dupEventBatch = [
      makeCandidate("황재균 18kg 감량 지연 달라진 얼굴", "황재균 지연", "entertainment", 69),
      makeCandidate("이혼 근황 황재균 18kg 감량 지연 올블랙", "황재균 지연", "entertainment", 69),
      makeCandidate("장동윤 결혼 발표 예비신부 화제", "연예", "entertainment", 60),
      ...makeFillerCandidates(200),
    ].sort((a, b) => b.totalScore - a.totalScore);
    const dupTop = selectDiverseTopN(dupEventBatch, 10);
    const hwang = dupTop.filter((item) => item.seedQuery === "황재균 지연");
    assert(hwang.length === 1, `구체 seedQuery "황재균 지연"은 Top 10에 1건만 있어야 한다 (실제 ${hwang.length}건)`);
    console.log('  ✅ 구체 seedQuery "황재균 지연" -> Top 10에 1건');
  }
  {
    // 서로 다른 작품 2편, 같은 분류어 seedQuery "넷플릭스" - 둘 다 남아야 한다(과병합 방지).
    const platformBatch = [
      makeCandidate("넷플릭스 오징어게임 스핀오프 제작 발표", "넷플릭스", "ott", 70),
      makeCandidate("넷플릭스 지금 뜨는 미드 원피스 시즌2 공개", "넷플릭스", "ott", 68),
      ...makeFillerCandidates(200),
    ].sort((a, b) => b.totalScore - a.totalScore);
    const platformTop = selectDiverseTopN(platformBatch, 10, { categoryTerms: ["넷플릭스"] });
    const netflix = platformTop.filter((item) => item.seedQuery === "넷플릭스");
    assert(netflix.length === 2, `분류어 seedQuery "넷플릭스"는 서로 다른 작품 2건이 남아야 한다 (실제 ${netflix.length}건)`);
    console.log('  ✅ 분류어 seedQuery "넷플릭스" -> 서로 다른 작품 2건 유지');
  }

  console.log("\n✅ 전체 통과");
}

main();
